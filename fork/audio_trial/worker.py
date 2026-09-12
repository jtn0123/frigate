"""Run a read-only Frigate audio trial with a single shared CPU queue."""

import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from contextlib import ExitStack
from pathlib import Path

from queue_store import Queue, health_reason, retry_reasons
from telemetry import STAGE_FILE, Telemetry, atomic_json, best_effort

logger = logging.getLogger(__name__)
STOP = threading.Event()
API = os.environ.get("FRIGATE_API", "http://127.0.0.1:5000/api")
STATE = Path(os.environ.get("STATE_DIR", "/state"))
CAMERAS = os.environ.get("CAMERAS", "doorbell").split(",")
METRICS: Telemetry | None = None


def read_json(endpoint: str) -> dict | list:
    """Read Frigate without modifying events, configuration, or notifications."""
    with urllib.request.urlopen(API + endpoint, timeout=10) as response:
        return json.load(response)


def memory_available() -> int:
    """Read the LXC's shared memory budget, including sibling Frigate usage."""
    root = Path("/host-cgroup")
    limit = (root / "memory.max").read_text().strip()
    current = int((root / "memory.current").read_text())
    # lxcfs renders even bind-mounted meminfo for the calling Docker cgroup.
    # Use the Proxmox-verified parent limit when its ancestor is not visible.
    total = int(os.environ["PARENT_MEMORY_LIMIT_BYTES"])
    limit = total if limit == "max" else min(total, int(limit))
    # Count reclaimable file cache, but preserve active allocations and a reserve.
    values = {
        key: int(value)
        for key, value in (
            line.split() for line in (root / "memory.stat").read_text().splitlines()
        )
    }
    reclaimable = values.get("inactive_file", 0)
    return max(0, limit - current + reclaimable - 512 * 1024**2)


def health(large: bool = False) -> str:
    """Fail closed if health or the shared memory limit cannot be checked."""
    try:
        config = read_json("/config")
        if any(
            config.get("cameras", {})
            .get(camera, {})
            .get("audio_transcription", {})
            .get("enabled")
            for camera in CAMERAS
        ):
            return "transcription ownership conflict"
        return health_reason(read_json("/stats"), memory_available(), large)
    except (OSError, ValueError, KeyError, RuntimeError):
        return "health check unavailable"


def running_health_reason() -> str:
    """Check camera pressure and the remaining reserve during inference."""
    # Model memory is already allocated, so check only camera load and reserve.
    try:
        reason = health_reason(read_json("/stats"), 100 * 1024**3)
        if memory_available() < 512 * 1024**2:
            return "memory reserve low"
        return reason
    except (OSError, ValueError, KeyError):
        return "health unavailable"


def stop_inference(process: subprocess.Popen) -> None:
    """Reap an unfinished inference process, escalating after a bounded wait."""
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def infer(audio: Path, output: Path, model: str) -> dict:
    """Bound inference time and stop optional work during sustained camera stress."""
    best_effort(STAGE_FILE.unlink)(missing_ok=True)
    checkpoint = output.with_suffix(".checkpoint.json")
    with ExitStack() as stack:
        log = best_effort((STATE / "inference.log").open)("w")
        if log is not None:
            stack.enter_context(log)
        result_file = stack.enter_context(output.open("w"))
        process = subprocess.Popen(
            [
                sys.executable,
                "infer.py",
                str(audio),
                "--model",
                model,
                "--checkpoint",
                str(checkpoint),
            ],
            stdout=result_file,
            stderr=log if log is not None else subprocess.DEVNULL,
        )
        start = time.monotonic()
        busy_checks = 0
        try:
            while process.poll() is None:
                if STOP.wait(3):
                    raise RuntimeError("worker stopping")
                if METRICS:
                    METRICS.sample(process.pid)
                reason = running_health_reason()
                busy_checks = busy_checks + 1 if reason else 0
                if busy_checks >= 3:
                    raise RuntimeError("camera processing needs priority")
                if time.monotonic() - start > 180:
                    raise RuntimeError("inference time limit")
            if process.returncode:
                raise RuntimeError(f"inference exited {process.returncode}")
        except RuntimeError:
            if checkpoint.exists():
                result = json.loads(checkpoint.read_text())
                result["status"] = "partial analysis; interrupted; unverified"
                result["interrupted"] = True
                for stage in result.get("stages", {}).values():
                    if stage["status"] == "running":
                        stage["status"] = "failed"
                        stage["error"] = "Interrupted"
                return result
            raise
        finally:
            stop_inference(process)
            if METRICS:
                METRICS.sample()
    return json.loads(output.read_text())


def download_audio(job: dict, directory: Path) -> Path:
    """Fetch a bounded recording clip and decode its audio into temporary storage."""
    camera = urllib.parse.quote(job["camera"], safe="")
    endpoint = f"/{camera}/start/{job['start']}/end/{job['end']}/clip.mp4"
    clip = directory / "clip.mp4"
    deadline = time.monotonic() + 60
    with (
        urllib.request.urlopen(API + endpoint, timeout=10) as response,
        clip.open("wb") as file,
    ):
        count = 0
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > 100 * 1024**2 or time.monotonic() > deadline or STOP.is_set():
                raise RuntimeError("clip download limit")
            file.write(chunk)
    audio = directory / "audio.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            str(clip),
            "-vn",
            "-t",
            "30",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(audio),
        ],
        check=True,
        timeout=30,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return audio


def write_status(queue: Queue, status: str) -> None:
    """Publish an atomic operator report without exposing a new network service."""
    rows = queue.recent()
    for row in rows:
        if row["result"]:
            row["result"] = json.loads(row["result"])
    report = {
        "updated": time.time(),
        "status": status,
        "cameras": CAMERAS,
        "jobs": rows,
    }
    best_effort(atomic_json)(STATE / "status.json", report)
    if METRICS:
        METRICS.queue = dict(
            queue.db.execute("SELECT state,COUNT(*) FROM jobs GROUP BY state")
        )
        for state in ("pending", "running", "done", "failed", "expired"):
            METRICS.queue.setdefault(state, 0)
        METRICS.queue["pending"] += METRICS.queue.get("second_opinion", 0)
        oldest = queue.db.execute(
            "SELECT MIN(created) FROM jobs WHERE state IN ('pending','second_opinion')"
        ).fetchone()[0]
        METRICS.oldest_wait = max(0, time.time() - oldest) if oldest else 0
        try:
            METRICS.available = memory_available()
        except (OSError, ValueError, KeyError):
            METRICS.available = None
        METRICS.pause_reason = next(
            (
                code
                for word, code in (
                    ("transcription", "transcription"),
                    ("memory", "memory"),
                    ("detector", "detector"),
                    ("frames", "frames"),
                    ("health", "health"),
                    ("poll", "poll"),
                )
                if word in status
            ),
            "",
        )
        METRICS.sample()


def process_job(queue: Queue, job: dict) -> None:
    """Run Medium first and preserve both outputs if a bounded retry is possible."""
    with tempfile.TemporaryDirectory(prefix="audio-") as directory:
        root = Path(directory)
        audio = download_audio(job, root)
        result = (
            json.loads(job["result"])
            if job.get("result")
            else infer(audio, root / "medium.json", "medium")
        )
        if result.get("interrupted"):
            queue.finish(job, time.time(), result)
            return
        reasons = retry_reasons(result)
        result["retry_reasons"] = reasons
        result["large_status"] = "not needed"
        if reasons:
            result["large_status"] = "second opinion pending; may be interrupted"
            queue.checkpoint(job, time.time(), result)
            # Retry timestamps are saved before execution, so crashes consume budget.
            budget_path = STATE / "large-budget.json"
            history = (
                json.loads(budget_path.read_text()) if budget_path.exists() else []
            )
            history = [t for t in history if t > time.time() - 3600]
            reason = health(large=True)
            if len(history) >= 2:
                result["large_status"] = "hourly retry limit"
                queue.defer(job, time.time(), result)
                return
            elif reason:
                result["large_status"] = "deferred: " + reason
                queue.defer(job, time.time(), result)
                return
            else:
                history.append(time.time())
                budget_temporary = budget_path.with_suffix(".tmp")
                budget_temporary.write_text(json.dumps(history))
                budget_temporary.replace(budget_path)
                try:
                    result["large_second_opinion"] = infer(
                        audio, root / "large.json", "large-v3"
                    )
                    result["large_status"] = (
                        "second opinion; not independently verified"
                    )
                except (OSError, ValueError, RuntimeError) as error:
                    result["large_status"] = "retry failed: " + str(error)
        queue.finish(job, time.time(), result)


def main() -> None:
    """Poll settled events and serialize all heavy analysis across cameras."""
    global METRICS
    STATE.mkdir(parents=True, exist_ok=True)
    METRICS = Telemetry(Path(os.environ.get("TELEMETRY_DIR", "/telemetry")))
    queue = Queue(str(STATE / "queue.sqlite"))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    next_poll = 0.0
    while not STOP.is_set():
        completed_job = False
        try:
            queue.flush_publications()
            if time.monotonic() >= next_poll:
                params = urllib.parse.urlencode(
                    {
                        "cameras": ",".join(CAMERAS),
                        "after": time.time() - 600,
                        "limit": 500,
                    }
                )
                queue.enqueue(read_json("/review?" + params), time.time(), CAMERAS)
                next_poll = time.monotonic() + 10
            reason = health()
            write_status(queue, "paused: " + reason if reason else "listening")
            job = None if reason else queue.claim(time.time())
            if job:
                write_status(queue, "processing " + job["id"])
                try:
                    process_job(queue, job)
                    logger.info("Completed audio job %s", job["id"])
                except (
                    OSError,
                    ValueError,
                    RuntimeError,
                    subprocess.SubprocessError,
                ) as error:
                    # Do not put audio contents, URLs, or model output in logs.
                    queue.fail(job, time.time(), type(error).__name__)
                    logger.warning(
                        "Audio job %s failed: %s", job["id"], type(error).__name__
                    )
                write_status(queue, "listening")
                completed_job = True
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            logger.warning("Poll unavailable: %s", type(error).__name__)
            write_status(queue, "paused: poll unavailable")
        # Drain ready jobs immediately, rechecking camera health before each one.
        # Empty, deferred, and unhealthy queues retain an interruptible cooldown.
        if not completed_job:
            STOP.wait(10)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    main()
