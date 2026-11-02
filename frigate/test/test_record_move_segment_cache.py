"""B43 (upstream #24704): move_segment releases its cache file and cache entry."""

import asyncio
import datetime
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frigate.record.maintainer import RecordingMaintainer, SegmentInfo
from frigate.record.move_failures import MoveFailures
from frigate.test.test_record_final_integrity import ProbeProcess, media_probe


class TestMoveSegmentCache(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.cache = root / "front@20261008010000+0000.mp4"
        self.cache.write_bytes(b"cached video")
        self.recordings = root / "recordings"
        self.destination = self.recordings / "2026-10-08" / "01" / "front" / "00.00.mp4"
        self.maintainer = RecordingMaintainer.__new__(RecordingMaintainer)
        self.maintainer.config = SimpleNamespace(
            ffmpeg=SimpleNamespace(ffmpeg_path="ffmpeg", ffprobe_path="ffprobe")
        )
        self.maintainer.end_time_cache = {str(self.cache): MagicMock()}
        self.maintainer.last_segment_end = {}
        self.maintainer.move_failures = MoveFailures()
        self.maintainer.probe_semaphore = asyncio.Semaphore(1)
        self.maintainer.recordings_publisher = MagicMock()
        self.spawned: list[tuple] = []
        record_dir = patch("frigate.record.maintainer.RECORD_DIR", str(self.recordings))
        record_dir.start()
        self.addCleanup(record_dir.stop)

    async def spawn(self, *args, **kwargs):
        self.spawned.append(args)
        if "-show_packets" in args:
            return ProbeProcess(json.dumps(media_probe(10)).encode())
        Path(args[-1]).write_bytes(b"saved video")
        return ProbeProcess()

    async def move(self):
        start = datetime.datetime(2026, 10, 8, 1, tzinfo=datetime.UTC)
        with patch("asyncio.create_subprocess_exec", side_effect=self.spawn):
            return await self.maintainer.move_segment(
                "front",
                "main",
                start,
                start + datetime.timedelta(seconds=10),
                10.0,
                str(self.cache),
                SegmentInfo(0, 0, 0, 0),
            )

    async def test_successful_move_clears_the_end_time_cache_entry(self):
        row = await self.move()

        self.assertIsNotNone(row)
        self.assertTrue(self.destination.exists())
        self.assertFalse(self.cache.exists())
        self.assertNotIn(str(self.cache), self.maintainer.end_time_cache)

    async def test_existing_destination_drops_the_cache_file(self):
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"existing")

        row = await self.move()

        self.assertIsNone(row)
        self.assertEqual(self.spawned, [])
        self.assertFalse(self.cache.exists())
        self.assertNotIn(str(self.cache), self.maintainer.end_time_cache)
        self.assertEqual(self.destination.read_bytes(), b"existing")


if __name__ == "__main__":
    unittest.main()
