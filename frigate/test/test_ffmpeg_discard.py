"""Tests for waiting on a detect ffmpeg without keeping its output (SV11)."""

import subprocess as sp
import sys
import threading
import unittest
from unittest.mock import MagicMock, call, patch

from frigate.test.test_camera_watchdog import build_watchdog
from frigate.video import discard
from frigate.video.discard import wait_discarding

# Writes far more than a pipe holds, so it blocks unless something reads.
FLOOD = (
    "import sys\n"
    "chunk = b'x' * (1 << 20)\n"
    "for _ in range(64):\n"
    "    sys.stdout.buffer.write(chunk)\n"
    "sys.stdout.buffer.flush()\n"
)
SLEEP = "import time\ntime.sleep(60)\n"


def start(code: str) -> sp.Popen:
    return sp.Popen([sys.executable, "-c", code], stdout=sp.PIPE, stdin=sp.DEVNULL)


class TestWaitDiscarding(unittest.TestCase):
    def test_drains_output_so_the_process_can_exit(self) -> None:
        process = start(FLOOD)
        self.addCleanup(process.stdout.close)

        self.assertEqual(wait_discarding(process, timeout=30), 0)

    def test_keeps_none_of_the_output(self) -> None:
        process = start(FLOOD)
        self.addCleanup(process.stdout.close)
        chunks: list[int] = []
        real_read = discard.os.read

        def counting_read(fd: int, size: int) -> bytes:
            data = real_read(fd, size)
            chunks.append(len(data))
            return data

        with patch.object(discard.os, "read", counting_read):
            wait_discarding(process, timeout=30)

        self.assertEqual(sum(chunks), 64 << 20)
        self.assertLessEqual(max(chunks), discard.READ_BYTES)

    def test_times_out_like_communicate_and_can_be_called_again(self) -> None:
        process = start(SLEEP)
        self.addCleanup(process.stdout.close)

        with self.assertRaises(sp.TimeoutExpired):
            wait_discarding(process, timeout=0.2)

        first = discard._drains[process]
        process.kill()
        self.assertEqual(wait_discarding(process), -9)
        self.assertIs(discard._drains[process], first)
        self.assertFalse(first.is_alive())

    def test_reads_a_duplicate_so_a_recycled_descriptor_is_never_touched(self) -> None:
        process = start(SLEEP)
        original = process.stdout.fileno()
        seen: list[int] = []
        done = threading.Event()

        def fake_discard(fd: int) -> None:
            seen.append(fd)
            discard.os.close(fd)
            done.set()

        with patch.object(discard, "_discard", fake_discard):
            process.kill()
            wait_discarding(process, timeout=10)

        self.assertTrue(done.wait(5))
        self.assertNotEqual(seen, [original])
        process.stdout.close()

    def test_process_without_a_pipe_just_waits(self) -> None:
        process = sp.Popen([sys.executable, "-c", "pass"], stdout=sp.DEVNULL)

        self.assertEqual(wait_discarding(process, timeout=30), 0)
        self.assertNotIn(process, discard._drains)

    def test_closed_pipe_just_waits(self) -> None:
        process = start("pass")
        process.stdout.close()

        self.assertEqual(wait_discarding(process, timeout=30), 0)
        self.assertNotIn(process, discard._drains)

    def test_warns_when_the_pipe_outlives_the_process(self) -> None:
        process = start("pass")
        self.addCleanup(process.stdout.close)
        release = threading.Event()

        with (
            patch.object(discard, "_discard", lambda fd: release.wait()),
            patch.object(discard, "JOIN_SECONDS", 0.1),
            self.assertLogs(discard.logger, "WARNING") as logs,
        ):
            wait_discarding(process, timeout=30)

        release.set()
        self.assertIn("still open", logs.output[0])

    def test_discard_survives_a_pipe_that_went_away(self) -> None:
        read_end, write_end = discard.os.pipe()
        discard.os.close(write_end)

        with patch.object(discard.os, "read", side_effect=OSError):
            discard._discard(read_end)

        with self.assertRaises(OSError):
            discard.os.fstat(read_end)


class TestDetectResetDiscards(unittest.TestCase):
    def test_detect_reset_never_collects_ffmpeg_output(self) -> None:
        watchdog = build_watchdog()
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = None
        watchdog.start_ffmpeg_detect = MagicMock()
        watchdog.restart_log = MagicMock()

        with patch(
            "frigate.video.ffmpeg.wait_discarding",
            side_effect=[sp.TimeoutExpired("ffmpeg", 30), 0],
        ) as wait:
            watchdog.reset_capture_thread()

        self.assertEqual(
            wait.call_args_list,
            [
                call(watchdog.ffmpeg_detect_process, timeout=30),
                call(watchdog.ffmpeg_detect_process),
            ],
        )
        watchdog.ffmpeg_detect_process.kill.assert_called_once()
        watchdog.ffmpeg_detect_process.communicate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
