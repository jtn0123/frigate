"""Fork (SV12): restart a camera's capture process when it dies or hangs.

Nothing watched the capture processes themselves. Each one runs the watchdog
that restarts its camera's ffmpeg, so when the kernel killed one (out of
memory) the camera had no watchdog left: its ffmpeg was never started again,
its stats froze at their last values, and Frigate kept reporting the camera as
running for six days. `CaptureSupervisor` runs in the camera maintainer, which
owns those processes. It restarts one that exited, and one whose watchdog has
not reported for `STUCK_SECONDS`, with a growing pause between attempts.
"""

import logging
import multiprocessing as mp
import os
import signal
import time
from collections.abc import Callable
from typing import NamedTuple

import psutil

from frigate.camera import CameraMetrics
from frigate.const import CACHE_DIR, CACHE_SEGMENT_FORMAT, SUB_CACHE_TAG
from frigate.video.restart_log import RestartLog

logger = logging.getLogger(__name__)

# How often the maintainer's one second loop looks at the capture processes.
CHECK_SECONDS = 5
# A watchdog loop normally turns once a second. Stopping several ffmpeg
# processes can hold it for a couple of minutes, so only a much longer silence
# counts as hung.
STUCK_SECONDS = 300
# The first restart is immediate. Each further one for the same camera waits
# this long after the one before, so a process that dies at once does not spin.
BACKOFF_SECONDS: tuple[int, ...] = (30, 60, 120, 300)
# A process that ran this long starts again from the first pause.
SETTLED_SECONDS = 3600
STOP_SECONDS = 5


class Verdict(NamedTuple):
    """Why a capture process is being restarted."""

    reason: str  # "died" or "stuck"
    message: str


def describe_exit(exitcode: int | None) -> str:
    """Say how a capture process ended, in words that fit a restart entry."""
    if exitcode is None:
        return "capture process stopped"
    if exitcode == -signal.SIGKILL:
        return (
            "capture process was killed (signal 9), usually by the kernel "
            "when memory ran out"
        )
    if exitcode < 0:
        return f"capture process was stopped by signal {-exitcode}"
    return f"capture process exited with code {exitcode}"


def record_outputs(camera: str) -> set[str]:
    """Return the record segment patterns this camera's ffmpeg writes to."""
    base = os.path.join(CACHE_DIR, camera)
    return {
        f"{base}@{CACHE_SEGMENT_FORMAT}.mp4",
        f"{base}{SUB_CACHE_TAG}@{CACHE_SEGMENT_FORMAT}.mp4",
    }


def leftover_ffmpeg(camera: str, detect_pid: int) -> list[psutil.Process]:
    """Find ffmpeg processes a dead capture process left running.

    Each ffmpeg runs in its own session, so it outlives the capture process
    that started it. A recorder left behind would write the same segments as
    its replacement.
    """
    outputs = record_outputs(camera)
    found: list[psutil.Process] = []
    for process in psutil.process_iter(["pid", "name", "cmdline"]):
        if process.info["name"] != "ffmpeg":
            continue
        cmdline = process.info["cmdline"] or []
        if process.info["pid"] == detect_pid or outputs.intersection(cmdline):
            found.append(process)
    return found


def stop_leftover_ffmpeg(camera: str, detect_pid: int) -> int:
    """Stop this camera's orphaned ffmpeg processes and return how many."""
    leftovers = leftover_ffmpeg(camera, detect_pid)
    for process in leftovers:
        try:
            process.terminate()
        except psutil.Error:
            continue
    _, alive = psutil.wait_procs(leftovers, timeout=STOP_SECONDS)
    for process in alive:
        try:
            process.kill()
        except psutil.Error:
            continue
    return len(leftovers)


def stop_process(process: mp.Process) -> None:
    """Stop a hung capture process without touching the camera's stop event.

    The stop event is shared with the camera's tracker process, which must keep
    running, so the process is signaled directly.
    """
    process.terminate()
    process.join(STOP_SECONDS)
    if process.is_alive():
        process.kill()
        process.join(STOP_SECONDS)


class CaptureSupervisor:
    """Decide when a capture process needs restarting, and clean up after it."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self.last_check = 0.0
        # camera -> (pid of its current process, when that pid was first seen)
        self.started: dict[str, tuple[int | None, float]] = {}
        # camera -> (restarts in a row, earliest time of the next one)
        self.attempts: dict[str, tuple[int, float]] = {}

    def due(self) -> bool:
        """Report whether it is time to check, at most every `CHECK_SECONDS`."""
        now = self.clock()
        if now - self.last_check < CHECK_SECONDS:
            return False
        self.last_check = now
        return True

    def verdict(
        self,
        camera: str,
        pid: int | None,
        alive: bool,
        exitcode: int | None,
        heartbeat: float,
    ) -> Verdict | None:
        """Judge one capture process.

        Args:
            camera: The camera the process captures.
            pid: The process's pid. A new pid (the maintainer replaced the
                process) starts the clock again.
            alive: Whether the process is still running.
            exitcode: Its exit code once it has ended.
            heartbeat: When its watchdog loop last turned, or 0 before the
                first turn.

        Returns:
            Why to restart it now, or None to leave it alone (healthy, or
            still inside the pause after an earlier restart).
        """
        now = self.clock()
        seen_pid, started = self.started.get(camera, (None, now))
        if seen_pid != pid:
            started = now
            self.started[camera] = (pid, now)
        silent = now - max(heartbeat, started)

        if alive and silent < STUCK_SECONDS:
            count, _ = self.attempts.get(camera, (0, 0.0))
            if count and now - started >= SETTLED_SECONDS:
                self.attempts.pop(camera, None)
            return None

        count, not_before = self.attempts.get(camera, (0, 0.0))
        if now < not_before:
            return None

        pause = BACKOFF_SECONDS[min(count, len(BACKOFF_SECONDS) - 1)]
        self.attempts[camera] = (count + 1, now + pause)

        if alive:
            return Verdict(
                "stuck", f"capture process made no progress for {int(silent)} seconds"
            )
        return Verdict("died", describe_exit(exitcode))

    def restart_needed(
        self, camera: str, process: mp.Process, metrics: CameraMetrics
    ) -> bool:
        """Check one capture process and prepare the camera for a new one.

        When the process died or hung this stops what is left of it, zeroes
        the frame rates it can no longer update, and adds the restart to the
        camera's restart history.

        Args:
            camera: The camera the process captures.
            process: The capture process the maintainer started.
            metrics: The camera's shared metrics.

        Returns:
            True when the caller should start a new capture process.
        """
        alive = process.is_alive()
        verdict = self.verdict(
            camera,
            process.pid,
            alive,
            process.exitcode,
            metrics.watchdog_heartbeat.value,
        )
        if verdict is None:
            return False

        if alive:
            stop_process(process)
        stopped = stop_leftover_ffmpeg(camera, metrics.ffmpeg_pid.value)

        # The dead process can no longer update these, so they would stay at
        # their last values and the camera would look like it is running.
        metrics.camera_fps.value = 0
        metrics.skipped_fps.value = 0
        metrics.ffmpeg_pid.value = 0
        metrics.watchdog_heartbeat.value = 0

        RestartLog(camera, logger, metrics.restart_events).record(
            "capture", "other", verdict.message
        )
        logger.error(
            "%s: %s; starting a new capture process (%d leftover ffmpeg stopped)",
            camera,
            verdict.message,
            stopped,
        )
        return True
