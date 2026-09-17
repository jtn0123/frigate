"""Fork (SV9): ffmpeg output that is noise is not logged at error."""

import logging
import unittest
from collections import deque
from types import SimpleNamespace

from frigate.log import LogPipe
from frigate.util.log_filters import FfmpegLogFilter

AMDGPU_LINES = [
    "amdgpu: os_same_file_description couldn't determine if two DRM fds "
    "reference the same file description.",
    "If they do, bad things may happen!",
]
REAL_ERROR = "[in#0/rtsp @ 0x55d0c8e0a2c0] Error opening input: Connection refused"


def dump(lines, level=logging.ERROR):
    """Run `LogPipe.dump` over `lines` without opening a pipe or a thread."""
    pipe = SimpleNamespace(
        deque=deque(lines),
        logger=logging.getLogger("ffmpeg.back.detect"),
        level=level,
        noise_filter=FfmpegLogFilter(),
    )
    LogPipe.dump(pipe)
    return pipe


class TestFfmpegLogFilter(unittest.TestCase):
    def setUp(self):
        self.filter = FfmpegLogFilter()

    def test_mesa_chatter_and_its_hint_are_debug(self):
        self.assertEqual(
            [self.filter.level_for(line, logging.ERROR) for line in AMDGPU_LINES],
            [logging.DEBUG, logging.DEBUG],
        )

    def test_an_ffmpeg_error_keeps_the_pipe_level(self):
        self.assertEqual(
            self.filter.level_for(REAL_ERROR, logging.ERROR), logging.ERROR
        )


class TestLogPipeDump(unittest.TestCase):
    def setUp(self):
        self.logger = logging.getLogger("ffmpeg.back.detect")

    def test_the_mesa_lines_are_not_logged_at_error(self):
        with self.assertLogs(self.logger, level="DEBUG") as logs:
            dump([*AMDGPU_LINES, REAL_ERROR])

        self.assertEqual(
            [record.levelno for record in logs.records],
            [logging.DEBUG, logging.DEBUG, logging.ERROR],
        )

    def test_every_line_is_still_logged(self):
        with self.assertLogs(self.logger, level="DEBUG") as logs:
            pipe = dump([*AMDGPU_LINES, REAL_ERROR])

        self.assertEqual(
            [record.getMessage() for record in logs.records],
            [AMDGPU_LINES[0], AMDGPU_LINES[1], REAL_ERROR],
        )
        self.assertEqual(len(pipe.deque), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
