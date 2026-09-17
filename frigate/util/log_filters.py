"""Fork (SV9, SV10): level ffmpeg output that is noise rather than failure.

`LogPipe` keeps the last 100 lines an ffmpeg process wrote and logs all of
them at error when the process exits. Some of those lines are chatter from
the graphics stack that says nothing about the stream, so they are logged at
debug instead and the error level keeps meaning something. Others are real
but repeat once per frame, so only the first one in a window is logged and
the rest are counted into one summary line.
"""

import logging
import time

# Mesa prints this on AMD hosts (and a follow-up hint line) when it cannot
# tell whether two DRM file descriptors point at the same file description.
# It is a warning about a fallback inside Mesa, not an ffmpeg failure, and it
# shows up on every hardware-accelerated stream on a rocm build. Its hint
# ("If they do, bad things may happen!") follows on its own line.
DEBUG_MARKERS: tuple[str, ...] = (
    "os_same_file_description",
    "If they do, bad things may happen",
)


# How long one rate-limited message stays quiet after it was logged.
RATE_LIMIT_SECONDS = 600

# Wi-Fi cameras with drifting timestamps make ffmpeg print this once per
# affected frame, which is harmless (ffmpeg fixes the timestamp itself) but
# ran to hundreds of lines a day per camera on the fork owner's server.
RATE_LIMITED_MARKERS: tuple[str, ...] = ("Non-monotonic DTS",)


class FfmpegLogFilter:
    """Decide the level each line of one ffmpeg process's output is worth.

    One filter belongs to one `LogPipe`, so its rate limiting is per camera
    and role.
    """

    def __init__(self, window: float = RATE_LIMIT_SECONDS) -> None:
        self.window = window
        # marker -> when it was last logged, and how many were left out since
        self._logged_at: dict[str, float] = {}
        self._suppressed: dict[str, int] = {}

    def level_for(self, line: str, level: int, now: float | None = None) -> int | None:
        """Return the level to log `line` at, or None to leave it out."""
        if any(marker in line for marker in DEBUG_MARKERS):
            return logging.DEBUG

        marker = next((m for m in RATE_LIMITED_MARKERS if m in line), None)

        if marker is None:
            return level

        now = time.time() if now is None else now
        logged_at = self._logged_at.get(marker)

        if logged_at is None or now - logged_at >= self.window:
            self._logged_at[marker] = now
            # A stream warning, whatever level the rest of the dump uses.
            return logging.WARNING

        self._suppressed[marker] = self._suppressed.get(marker, 0) + 1
        return None

    def summaries(self) -> list[str]:
        """One line per rate-limited message left out since the last call."""
        lines = [
            f"{count} more '{marker}' warnings from this stream in the last "
            f"{int(self.window)}s were not logged"
            for marker, count in sorted(self._suppressed.items())
            if count > 0
        ]
        self._suppressed.clear()
        return lines
