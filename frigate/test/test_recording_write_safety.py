"""Regression coverage for recoverable recording conversion failures."""

import asyncio
import datetime
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frigate.record.maintainer import RecordingMaintainer, SegmentInfo


class TestRecordingWriteSafety(unittest.IsolatedAsyncioTestCase):
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
        self.start = datetime.datetime(2026, 9, 13, tzinfo=datetime.UTC)
        self.end = self.start + datetime.timedelta(seconds=10)
        self.info = SegmentInfo(0, 0, 0, 0)
        self.record_dir = self.root / "recordings"
        self.final = self.record_dir / "2026-09-13/00/front/00.00.mp4"
        patcher = patch("frigate.record.maintainer.RECORD_DIR", str(self.record_dir))
        patcher.start()
        self.addCleanup(patcher.stop)

    async def move(self):
        return await self.maintainer.move_segment(
            "front", self.start, self.end, 10, str(self.cache), self.info
        )

    async def test_process_start_failure_preserves_original_for_retry(self):
        with patch(
            "frigate.record.maintainer.asyncio.create_subprocess_exec",
            side_effect=OSError("temporarily out of process slots"),
        ):
            self.assertIsNone(await self.move())
        self.assertEqual(self.cache.read_bytes(), b"original footage")
        self.assertFalse(self.final.exists())

    async def test_failed_conversion_does_not_publish_partial_recording(self):
        spawn = asyncio.create_subprocess_exec

        async def failing_process(*args, **kwargs):
            return await spawn(
                sys.executable,
                "-c",
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_bytes(b'partial');sys.exit(1)",
                args[-1],
                **kwargs,
            )

        with patch(
            "frigate.record.maintainer.asyncio.create_subprocess_exec",
            side_effect=failing_process,
        ):
            self.assertIsNone(await self.move())
        self.assertTrue(self.cache.exists())
        self.assertFalse(self.final.exists())

    async def test_verbose_conversion_drains_stderr_and_completes(self):
        spawn = asyncio.create_subprocess_exec
        processes = []

        async def verbose_process(*args, **kwargs):
            process = await spawn(
                sys.executable,
                "-c",
                "import pathlib,sys;sys.stderr.write('x'*1048576);sys.stderr.flush();pathlib.Path(sys.argv[1]).write_bytes(b'complete')",
                args[-1],
                **kwargs,
            )
            processes.append(process)
            return process

        try:
            with patch(
                "frigate.record.maintainer.asyncio.create_subprocess_exec",
                side_effect=verbose_process,
            ):
                result = await asyncio.wait_for(self.move(), timeout=5)
            self.assertIsNotNone(result)
            self.assertEqual(self.final.read_bytes(), b"complete")
            self.assertFalse(self.cache.exists())
        finally:
            for process in processes:
                if process.returncode is None:
                    process.kill()
                await process.communicate()

    async def test_hung_conversion_is_killed_and_original_is_retained(self):
        spawn = asyncio.create_subprocess_exec
        processes = []

        async def hung_process(*args, **kwargs):
            process = await spawn(
                sys.executable, "-c", "import time;time.sleep(30)", **kwargs
            )
            processes.append(process)
            return process

        try:
            with (
                patch(
                    "frigate.record.maintainer.RECORDING_CONVERSION_TIMEOUT",
                    0.05,
                    create=True,
                ),
                patch(
                    "frigate.record.maintainer.asyncio.create_subprocess_exec",
                    side_effect=hung_process,
                ),
            ):
                result = await asyncio.wait_for(self.move(), timeout=3)
            self.assertIsNone(result)
            self.assertTrue(self.cache.exists())
            self.assertIsNotNone(processes[0].returncode)
        finally:
            for process in processes:
                if process.returncode is None:
                    process.kill()
                await process.communicate()

    async def test_real_ffmpeg_publishes_playable_recording(self):
        ffmpeg = "/usr/lib/ffmpeg/8.0/bin/ffmpeg"
        self.maintainer.config.ffmpeg.ffmpeg_path = ffmpeg
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=size=160x120:rate=5",
            "-t",
            "1",
            "-c:v",
            "libx264",
            str(self.cache),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, errors = await process.communicate()
        self.assertEqual(process.returncode, 0, errors)
        result = await self.move()
        self.assertIsNotNone(result)
        self.assertEqual(result["path"], str(self.final))
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(self.final),
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, errors = await process.communicate()
        self.assertEqual(process.returncode, 0, errors)
        self.assertFalse(self.cache.exists())
        self.assertFalse(Path(f"{self.final}.tmp").exists())

    async def test_completed_recording_is_registered_if_cache_removal_fails(self):
        spawn = asyncio.create_subprocess_exec

        async def successful_process(*args, **kwargs):
            return await spawn(
                sys.executable,
                "-c",
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_bytes(b'complete')",
                args[-1],
                **kwargs,
            )

        with (
            patch(
                "frigate.record.maintainer.asyncio.create_subprocess_exec",
                side_effect=successful_process,
            ),
            patch(
                "frigate.record.maintainer.os.remove",
                side_effect=PermissionError("cache temporarily busy"),
            ),
        ):
            result = await self.move()
        self.assertIsNotNone(result)
        self.assertEqual(result["path"], str(self.final))
        self.assertTrue(self.cache.exists())
