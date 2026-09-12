"""Run explicit recorded-data checks before starting the doorbell trial."""

import json
import threading
import time
from pathlib import Path

import worker
from queue_store import Queue
from telemetry import Telemetry


def main() -> None:
    """Exercise the real API, cached models, queue and hardware health monitor."""
    worker.STATE = Path(f"/state/validation-{int(time.time())}")
    worker.STATE.mkdir(parents=True, exist_ok=True)
    worker.METRICS = Telemetry(Path("/telemetry"))
    reason = worker.health()
    if reason:
        raise RuntimeError(reason)
    report = {"samples": [], "results": [], "started": time.time()}
    done = threading.Event()

    def sample():
        while not done.is_set():
            stats = worker.read_json("/stats")
            report["samples"].append(
                {
                    "time": time.time(),
                    "detectors": stats["detectors"],
                    "skipped_fps": {
                        k: v["skipped_fps"] for k, v in stats["cameras"].items()
                    },
                    "available_bytes": worker.memory_available(),
                }
            )
            done.wait(2)

    monitor = threading.Thread(target=sample)
    monitor.start()
    try:
        queue = Queue(str(worker.STATE / "queue.sqlite"))
        review = {
            "id": "validation-recorded-doorbell",
            "camera": "doorbell",
            "start_time": 1789224193.2238,
            "end_time": 1789224204.447584,
            "data": {"audio": ["speech"]},
        }
        queue.enqueue([review], review["end_time"] + 30, ["doorbell"])
        job = queue.claim(time.time())
        if job:
            worker.process_job(queue, job)
        result = json.loads(queue.recent()[0]["result"])
        assert result["transcript"], "Doorbell replay returned no transcript"
        report["results"].append({"id": "recorded-doorbell", "result": result})
        root = Path("/models/multilingual-benchmark-20260912")
        manifest = json.loads((root / "manifest.json").read_text())
        for language in ("ar", "fa"):
            clip = next(c for c in manifest["clips"] if c["language"] == language)
            result = worker.infer(
                root / clip["file"], worker.STATE / f"{language}.json", "medium"
            )
            assert result["transcript"] and result["translation"]
            report["results"].append({"id": clip["id"], "result": result})
            print("Completed", language, flush=True)
        noise = Path("/models/audio-alternatives-20260912")
        manifest = json.loads((noise / "sounds-manifest.json").read_text())
        clip = next(c for c in manifest["clips"] if c["category"] == "rain")
        audio = Path(clip["path"].replace("/config/model_cache", "/models"))
        result = worker.infer(audio, worker.STATE / "rain.json", "medium")
        assert not result["transcript"], "Rain produced a transcript"
        report["results"].append({"id": clip["id"], "result": result})
        report["passed"] = True
    finally:
        done.set()
        monitor.join(timeout=15)
        report["ended"] = time.time()
        (worker.STATE / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2)
        )
    print("Hardware smoke checks passed", flush=True)


if __name__ == "__main__":
    main()
