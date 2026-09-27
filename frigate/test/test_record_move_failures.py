"""Fork (D31): a cached segment that keeps failing to move is dropped."""

import asyncio
import datetime
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frigate.record.maintainer import RecordingMaintainer, SegmentInfo
from frigate.record.move_failures import MAX_MOVE_ATTEMPTS, MoveFailures


class TestMoveFailures(unittest.TestCase):
    def test_gives_up_after_the_limit(self):
        failures = MoveFailures(limit=3)

        self.assertFalse(failures.failed("a"))
        self.assertFalse(failures.failed("a"))
        with self.assertLogs("frigate.record.move_failures", level="WARNING"):
            self.assertTrue(failures.failed("a"))
        # A segment of the same name written later starts from zero.
        self.assertFalse(failures.failed("a"))

    def test_counts_each_segment_on_its_own(self):
        failures = MoveFailures(limit=2)

        self.assertFalse(failures.failed("a"))
        self.assertFalse(failures.failed("b"))
        with self.assertLogs("frigate.record.move_failures", level="WARNING"):
            self.assertTrue(failures.failed("a"))

    def test_forgets_segments_that_left_the_cache(self):
        failures = MoveFailures(limit=2)
        failures.failed("gone")
        failures.failed("kept")

        failures.keep_only(["kept"])

        self.assertFalse(failures.failed("gone"))
        with self.assertLogs("frigate.record.move_failures", level="WARNING"):
            self.assertTrue(failures.failed("kept"))


class TestMaintainerDropsFailingSegments(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / "cache.mp4"
        self.cache.write_bytes(b"original footage")
        self.maintainer = RecordingMaintainer.__new__(RecordingMaintainer)
        self.maintainer.config = SimpleNamespace(
            ffmpeg=SimpleNamespace(ffmpeg_path="ffmpeg")
        )
        self.maintainer.end_time_cache = {}
        self.maintainer.move_failures = MoveFailures()
        self.start = datetime.datetime(2026, 9, 13, tzinfo=datetime.UTC)
        self.end = self.start + datetime.timedelta(seconds=10)
        self.info = SegmentInfo(0, 0, 0, 0)
        self.final = self.root / "recordings/2026-09-13/00/front/00.00.mp4"
        patcher = patch(
            "frigate.record.maintainer.RECORD_DIR", str(self.root / "recordings")
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    async def move(self):
        return await self.maintainer.move_segment(
            "front", "main", self.start, self.end, 10, str(self.cache), self.info
        )

    async def attempts_until_dropped(self, spawn_script: str, **patches):
        spawn = asyncio.create_subprocess_exec

        async def process(*args, **kwargs):
            return await spawn(sys.executable, "-c", spawn_script, args[-1], **kwargs)

        with patch(
            "frigate.record.maintainer.asyncio.create_subprocess_exec",
            side_effect=process,
        ):
            for attempt in range(1, MAX_MOVE_ATTEMPTS + 1):
                self.assertIsNone(await self.move())
                if not self.cache.exists():
                    return attempt
        return None

    async def test_segment_whose_move_keeps_raising_is_dropped(self):
        with (
            patch(
                "frigate.record.maintainer.os.replace",
                side_effect=OSError("read-only file system"),
            ),
            self.assertLogs("frigate.record.move_failures", level="WARNING"),
        ):
            attempt = await self.attempts_until_dropped(
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_bytes(b'x')"
            )

        self.assertEqual(attempt, MAX_MOVE_ATTEMPTS)
        self.assertFalse(self.final.exists())
        self.assertNotIn(str(self.cache), self.maintainer.end_time_cache)

    async def test_segment_ffmpeg_keeps_rejecting_is_dropped(self):
        with self.assertLogs("frigate.record.move_failures", level="WARNING"):
            attempt = await self.attempts_until_dropped("import sys;sys.exit(1)")

        self.assertEqual(attempt, MAX_MOVE_ATTEMPTS)

    async def test_one_failure_still_keeps_the_original_for_a_retry(self):
        with patch(
            "frigate.record.maintainer.asyncio.create_subprocess_exec",
            side_effect=OSError("temporarily out of process slots"),
        ):
            self.assertIsNone(await self.move())

        self.assertTrue(self.cache.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
