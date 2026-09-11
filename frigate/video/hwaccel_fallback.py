"""Fork (D10): fall back to software decoding when hardware decoding keeps
crashing a camera's detect stream.

With a hardware preset the detect ffmpeg process decodes and scales on the
GPU and downloads each frame. On some camera and GPU combinations that
download occasionally fails ("Failed to sync surface" on VAAPI), and ffmpeg
treats a filter error as fatal, so the process exits and the watchdog
restarts it every minute or so, forever. Detection has a gap each time.

`HwaccelFallback` watches the detect process exits. When hardware-decoding
errors end the process `threshold` times within `window` seconds, it switches
that camera to a software-decoding command for as long as the watchdog lives
(until Frigate restarts or the camera's ffmpeg config changes) and says so,
instead of letting one flaky acceleration path keep taking the camera down.
Recording is untouched: Frigate only adds hardware arguments to the detect
input.
"""

import time
from collections import deque
from collections.abc import Iterable

from frigate.config import CameraConfig

# ffmpeg messages that mean the hardware decode, scale or download step
# failed, as opposed to the camera or the network. Matched as substrings of the
# detect process's last log lines.
HWACCEL_FAILURE_MARKERS: tuple[str, ...] = (
    "Failed to sync surface",  # VAAPI: the GPU never finished the surface
    "Failed to download frame",  # hwdownload filter
    "Failed to transfer data to output frame",  # decoder -> system memory copy
    "Failed to end picture decode",  # VAAPI decoder submit
    "hwaccel initialisation returned error",
    "Device creation failed",
    "No VA display found",
    "CUDA_ERROR_",
)

CRASHES_BEFORE_FALLBACK = 3
CRASH_WINDOW_SECONDS = 600


def hwaccel_failure_line(log_lines: Iterable[str]) -> str | None:
    """Return the first log line that names a hardware-decoding failure."""
    for line in log_lines:
        if any(marker in line for marker in HWACCEL_FAILURE_MARKERS):
            return line
    return None


def software_detect_cmd(config: CameraConfig) -> list[str] | None:
    """The camera's detect command with hardware acceleration removed.

    Built from a copy of the camera config with every hwaccel setting cleared,
    so the scale filter and all other arguments come from the same builder as
    the normal command. Returns None if the camera has no detect input.
    """
    software = config.model_copy(deep=True)
    software.ffmpeg.hwaccel_args = []
    for ffmpeg_input in software.ffmpeg.inputs:
        ffmpeg_input.hwaccel_args = []
    software.recreate_ffmpeg_cmds()
    for cmd in software.ffmpeg_cmds:
        if "detect" in cmd["roles"]:
            return cmd["cmd"]
    return None


class HwaccelFallback:
    """Decides when one camera's detect stream should stop using the GPU."""

    def __init__(
        self,
        config: CameraConfig,
        threshold: int = CRASHES_BEFORE_FALLBACK,
        window: float = CRASH_WINDOW_SECONDS,
    ) -> None:
        self.config = config
        self.threshold = threshold
        self.window = window
        self.active = False
        self.reason: str | None = None
        self._crashes: deque[float] = deque()
        self._software_cmd: list[str] | None = None

    def detect_cmd(self) -> list[str] | None:
        """The software command while the fallback is active, else None."""
        return self._software_cmd if self.active else None

    def record_crash(self, log_lines: Iterable[str], now: float | None = None) -> bool:
        """Note a detect process exit; True if it just switched to software."""
        if self.active:
            return False

        failure = hwaccel_failure_line(log_lines)
        if failure is None:
            return False

        now = time.monotonic() if now is None else now
        self._crashes.append(now)
        while self._crashes and self._crashes[0] < now - self.window:
            self._crashes.popleft()
        if len(self._crashes) < self.threshold:
            return False

        software_cmd = software_detect_cmd(self.config)
        current = [c["cmd"] for c in self.config.ffmpeg_cmds if "detect" in c["roles"]]
        if software_cmd is None or (current and current[0] == software_cmd):
            # Nothing to fall back from: the command already decodes in software.
            return False

        self._software_cmd = software_cmd
        self.active = True
        self.reason = failure.strip()
        return True

    def reset(self) -> None:
        """Forget crashes and go back to the configured command (config changed)."""
        self.active = False
        self.reason = None
        self._crashes.clear()
        self._software_cmd = None
