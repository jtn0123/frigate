"""Fork (SV9): level ffmpeg output that is noise rather than failure.

`LogPipe` keeps the last 100 lines an ffmpeg process wrote and logs all of
them at error when the process exits. Some of those lines are chatter from
the graphics stack that says nothing about the stream, so they are logged at
debug instead and the error level keeps meaning something.
"""

import logging

# Mesa prints this on AMD hosts (and a follow-up hint line) when it cannot
# tell whether two DRM file descriptors point at the same file description.
# It is a warning about a fallback inside Mesa, not an ffmpeg failure, and it
# shows up on every hardware-accelerated stream on a rocm build. Its hint
# ("If they do, bad things may happen!") follows on its own line.
DEBUG_MARKERS: tuple[str, ...] = (
    "os_same_file_description",
    "If they do, bad things may happen",
)


class FfmpegLogFilter:
    """Decide the level each line of one ffmpeg process's output is worth."""

    def level_for(self, line: str, level: int) -> int:
        """Return the level to log `line` at, given the pipe's own level."""
        if any(marker in line for marker in DEBUG_MARKERS):
            return logging.DEBUG

        return level
