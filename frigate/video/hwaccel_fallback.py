"""Fork (D10): fall back to software decoding when hardware decoding keeps
crashing a camera's detect stream.

With a hardware preset the detect ffmpeg process decodes and scales on the
GPU and downloads each frame. On some camera and GPU combinations that
download occasionally fails ("Failed to sync surface" on VAAPI), and ffmpeg
treats a filter error as fatal, so the process exits and the watchdog
restarts it every minute or so, forever. Detection has a gap each time.

`HwaccelFallback` watches the detect process exits. When hardware-decoding
errors end the process `threshold` times within `window` seconds, it switches
that camera to a software-decoding command and says so, instead of letting
one flaky acceleration path keep taking the camera down. Recording is
untouched: Frigate only adds hardware arguments to the detect input.

Fork (D14): the switch is remembered in a small file per camera for
`REMEMBER_SECONDS`, so a restart or an update starts that camera in software
right away instead of letting it crash three more times first. Hardware
decoding is tried again once the entry expires, or as soon as the camera's
ffmpeg settings change (the file records a hash of the configured command).
"""

import hashlib
import json
import logging
import os
import tempfile
import time
from collections import deque
from collections.abc import Iterable

from frigate.config import CameraConfig
from frigate.const import CONFIG_DIR

logger = logging.getLogger(__name__)

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
REMEMBER_SECONDS = 7 * 24 * 3600

FALLBACK_STATE_DIR = os.path.join(CONFIG_DIR, ".fork", "hwaccel_fallback")


def fallback_state_path(camera_name: str) -> str:
    """Where a camera's software-decoding switch is remembered."""
    return os.path.join(FALLBACK_STATE_DIR, f"{camera_name}.json")


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


def _configured_detect_cmd(config: CameraConfig) -> list[str] | None:
    for cmd in config.ffmpeg_cmds:
        if "detect" in cmd["roles"]:
            return cmd["cmd"]
    return None


def _fingerprint(cmd: list[str] | None) -> str:
    """A hash of the configured command, so a settings change is noticed
    without writing the stream URL (and its credentials) to disk."""
    return hashlib.sha256("\0".join(cmd or []).encode()).hexdigest()


class HwaccelFallback:
    """Decides when one camera's detect stream should stop using the GPU."""

    def __init__(
        self,
        config: CameraConfig,
        threshold: int = CRASHES_BEFORE_FALLBACK,
        window: float = CRASH_WINDOW_SECONDS,
        state_path: str | None = None,
        remember: float = REMEMBER_SECONDS,
        now: float | None = None,
    ) -> None:
        self.config = config
        self.threshold = threshold
        self.window = window
        self.state_path = state_path
        self.remember = remember
        self.active = False
        self.reason: str | None = None
        # Wall-clock time of the switch, kept across restarts (D14).
        self.since: float | None = None
        self._crashes: deque[float] = deque()
        self._software_cmd: list[str] | None = None
        if state_path is not None:
            self._restore(time.time() if now is None else now)

    @property
    def expires(self) -> float | None:
        """When hardware decoding is tried again, if the switch is active."""
        return self.since + self.remember if self.since is not None else None

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
        current = _configured_detect_cmd(self.config)
        if software_cmd is None or current == software_cmd:
            # Nothing to fall back from: the command already decodes in software.
            return False

        self._software_cmd = software_cmd
        self.active = True
        self.reason = failure.strip()
        self.since = time.time()
        self._save()
        return True

    def reset(self) -> None:
        """Forget crashes and go back to the configured command (config changed)."""
        self.active = False
        self.reason = None
        self.since = None
        self._crashes.clear()
        self._software_cmd = None
        self._forget()

    def _restore(self, now: float) -> None:
        """Pick up a switch from before a restart, if it still applies."""
        try:
            with open(self.state_path, encoding="utf-8") as file:
                saved = json.load(file)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as err:
            logger.warning(
                f"{self.config.name}: ignoring unreadable {self.state_path}: {err}"
            )
            self._forget()
            return

        current = _configured_detect_cmd(self.config)
        software_cmd = software_detect_cmd(self.config)
        since = saved.get("since") if isinstance(saved, dict) else None
        if (
            not isinstance(since, (int, float))
            or saved.get("config") != _fingerprint(current)
            or now - since >= self.remember
            or software_cmd is None
            or current == software_cmd
        ):
            # Expired, or the camera's ffmpeg settings changed since the switch.
            self._forget()
            return

        self._software_cmd = software_cmd
        self.active = True
        self.since = float(since)
        reason = saved.get("reason")
        self.reason = reason if isinstance(reason, str) else None

    def _save(self) -> None:
        if self.state_path is None:
            return
        state = {
            "since": self.since,
            "reason": self.reason,
            "config": _fingerprint(_configured_detect_cmd(self.config)),
        }
        directory = os.path.dirname(self.state_path)
        try:
            os.makedirs(directory, exist_ok=True)
            # Write then rename, so a crash mid-write never leaves half a file.
            fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(state, file)
            os.replace(tmp_path, self.state_path)
        except OSError as err:
            logger.warning(
                f"{self.config.name}: could not remember the software-decoding "
                f"switch in {self.state_path}, so a restart tries hardware "
                f"decoding again: {err}"
            )

    def _forget(self) -> None:
        if self.state_path is None:
            return
        try:
            os.remove(self.state_path)
        except FileNotFoundError:
            pass
        except OSError as err:
            logger.warning(
                f"{self.config.name}: could not remove {self.state_path}: {err}"
            )
