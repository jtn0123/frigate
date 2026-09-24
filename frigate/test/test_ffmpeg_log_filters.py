"""Fork (SV9, SV10): ffmpeg output that is noise does not flood the log."""

import logging
import unittest
from collections import deque
from types import SimpleNamespace

from frigate.log import LogPipe
from frigate.util.log_filters import RATE_LIMIT_SECONDS, FfmpegLogFilter

AMDGPU_LINES = [
    "amdgpu: os_same_file_description couldn't determine if two DRM fds "
    "reference the same file description.",
    "If they do, bad things may happen!",
]
REAL_ERROR = "[in#0/rtsp @ 0x55d0c8e0a2c0] Error opening input: Connection refused"


def dts_warning(current):
    return (
        "[segment @ 0x5f1c39b0f800] Non-monotonic DTS in output stream 0:0; "
        f"previous: 90000, current: {current}; changing to 90001"
    )


def dump(lines, level=logging.ERROR, noise_filter=None):
    """Run `LogPipe.dump` over `lines` without opening a pipe or a thread."""
    pipe = SimpleNamespace(
        deque=deque(lines),
        logger=logging.getLogger("ffmpeg.back.detect"),
        level=level,
        noise_filter=noise_filter or FfmpegLogFilter(),
    )
    LogPipe.dump(pipe)
    return pipe


HEADING = "The following ffmpeg logs include the last 100 lines prior to exit."


def body(logs):
    """The records a dump logged after its heading (D54)."""
    records = logs.records
    assert records[0].getMessage() == HEADING, records[0].getMessage()
    return records[1:]


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
            [record.levelno for record in body(logs)],
            [logging.DEBUG, logging.DEBUG, logging.ERROR],
        )

    def test_every_line_is_still_logged(self):
        with self.assertLogs(self.logger, level="DEBUG") as logs:
            pipe = dump([*AMDGPU_LINES, REAL_ERROR])

        self.assertEqual(
            [record.getMessage() for record in body(logs)],
            [AMDGPU_LINES[0], AMDGPU_LINES[1], REAL_ERROR],
        )
        self.assertEqual(len(pipe.deque), 0)

    def test_the_heading_is_logged_once_at_the_pipe_level(self):
        with self.assertLogs(self.logger, level="DEBUG") as logs:
            dump([REAL_ERROR], level=logging.WARNING)

        self.assertEqual(logs.records[0].getMessage(), HEADING)
        self.assertEqual(logs.records[0].levelno, logging.WARNING)
        self.assertEqual(len(body(logs)), 1)

    def test_an_empty_pipe_logs_nothing(self):
        """A restart that already drained the pipe prints no empty heading."""
        with self.assertNoLogs(self.logger, level="DEBUG"):
            dump([])


class TestNonMonotonicDts(unittest.TestCase):
    """Fork (SV10): the first one is logged, the rest are summarized."""

    def setUp(self):
        self.logger = logging.getLogger("ffmpeg.back.detect")
        self.filter = FfmpegLogFilter()

    def test_the_first_warning_is_logged_and_the_next_ones_are_not(self):
        levels = [
            self.filter.level_for(dts_warning(i), logging.ERROR, now=1000 + i)
            for i in range(4)
        ]

        self.assertEqual(levels, [logging.WARNING, None, None, None])

    def test_one_is_logged_again_once_the_window_passes(self):
        self.filter.level_for(dts_warning(0), logging.ERROR, now=1000)

        self.assertEqual(
            self.filter.level_for(
                dts_warning(1), logging.ERROR, now=1000 + RATE_LIMIT_SECONDS
            ),
            logging.WARNING,
        )

    def test_a_dump_logs_one_warning_and_one_summary(self):
        lines = [dts_warning(i) for i in range(50)] + [REAL_ERROR]

        with self.assertLogs(self.logger, level="DEBUG") as logs:
            dump(lines, noise_filter=self.filter)

        records = body(logs)
        self.assertEqual(
            [record.levelno for record in records],
            [logging.WARNING, logging.ERROR, logging.WARNING],
        )
        self.assertEqual(records[0].getMessage(), lines[0])
        self.assertIn("49 more 'Non-monotonic DTS' warnings", logs.output[-1])

    def test_a_later_dump_in_the_same_window_only_summarizes(self):
        dump([dts_warning(0)], noise_filter=self.filter)

        with self.assertLogs(self.logger, level="DEBUG") as logs:
            dump([dts_warning(1), dts_warning(2)], noise_filter=self.filter)

        self.assertEqual(len(body(logs)), 1)
        self.assertIn("2 more 'Non-monotonic DTS' warnings", logs.output[-1])

    def test_a_dump_without_repeats_says_nothing_extra(self):
        with self.assertLogs(self.logger, level="DEBUG") as logs:
            dump([REAL_ERROR], noise_filter=self.filter)

        self.assertEqual(len(body(logs)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
