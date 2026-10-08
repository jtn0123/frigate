"""SV14: register verified saved video instead of stale cache durations."""

import asyncio
import datetime
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from playhouse.sqlite_ext import SqliteExtDatabase
from zmq import ENOTSOCK, ZMQError

from frigate.models import Recordings
from frigate.record.maintainer import RecordingMaintainer, SegmentInfo
from frigate.record.move_failures import MoveFailures


def media_probe(video_seconds=0.48, audio_pts=None):
    """Describe real observed packet geometry without retaining camera footage."""
    frames = round(video_seconds * 25)
    packets = [
        {
            "stream_index": 0,
            "pts_time": str(index / 25),
            "dts_time": str(index / 25),
            "duration_time": "0.04",
            "flags": "K_" if index == 0 else "__",
        }
        for index in range(frames)
    ]
    streams = [{"index": 0, "codec_type": "video", "codec_name": "hevc"}]
    if audio_pts is not None:
        streams.append({"index": 1, "codec_type": "audio", "codec_name": "aac"})
        packets.append(
            {
                "stream_index": 1,
                "pts_time": str(audio_pts),
                "dts_time": str(audio_pts),
                "duration_time": "0.064",
                "flags": "K_",
            }
        )
    return {"format": {"start_time": "0"}, "streams": streams, "packets": packets}


class ProbeProcess:
    """Provide subprocess pipe behavior for synthetic packet fixtures."""

    def __init__(self, data=b"", returncode=0):
        self.returncode = returncode
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(data)
        self.stdout.feed_eof()
        self.data = data

    async def communicate(self):
        return self.data, b""

    async def wait(self):
        return self.returncode

    def kill(self):
        self.returncode = -9


class TestFinalRecordingIntegrity(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "front@20261008010000+0000.mp4"
        self.cache.write_bytes(b"preserved original video")
        self.recordings = self.root / "recordings"
        self.maintainer = RecordingMaintainer.__new__(RecordingMaintainer)
        self.maintainer.config = SimpleNamespace(
            ffmpeg=SimpleNamespace(ffmpeg_path="ffmpeg", ffprobe_path="ffprobe")
        )
        self.maintainer.end_time_cache = {}
        self.maintainer.last_segment_end = {}
        self.maintainer.move_failures = MoveFailures()
        self.maintainer.probe_semaphore = asyncio.Semaphore(1)
        self.maintainer.recordings_publisher = MagicMock()
        self.start = datetime.datetime(2026, 10, 8, 1, tzinfo=datetime.UTC)
        self.probe = media_probe()
        self.probe_exit = 0
        self.spawned = []
        self.database = SqliteExtDatabase(":memory:")
        self.bind = self.database.bind_ctx([Recordings])
        self.bind.__enter__()
        self.database.create_tables([Recordings])
        self.addCleanup(self.database.close)
        self.addCleanup(self.bind.__exit__, None, None, None)
        record_dir = patch("frigate.record.maintainer.RECORD_DIR", str(self.recordings))
        record_dir.start()
        self.addCleanup(record_dir.stop)

    async def spawn(self, *args, **kwargs):
        self.spawned.append(args)
        if "-show_packets" in args:
            return ProbeProcess(json.dumps(self.probe).encode(), self.probe_exit)
        Path(args[-1]).write_bytes(b"complete saved video")
        return ProbeProcess()

    async def save_and_register(self, source_duration):
        with patch("asyncio.create_subprocess_exec", side_effect=self.spawn):
            row = await self.maintainer.move_segment(
                "front",
                "main",
                self.start,
                self.start + datetime.timedelta(seconds=source_duration),
                source_duration,
                str(self.cache),
                SegmentInfo(0, 0, 0, 0),
            )
        if row is not None:
            Recordings.create(**row)
        return row

    async def test_119_second_cache_cannot_register_half_second_video_as_full(self):
        self.probe = media_probe(0.48, -45799.75225)
        row = await self.save_and_register(119.149125)
        self.assertIsNone(row)
        self.assertEqual(Recordings.select().count(), 0)
        self.assertTrue(any(self.recordings.rglob("*.mp4")))

    async def test_110_second_cache_cannot_register_one_second_video_as_full(self):
        self.probe = media_probe(1.12, -30677.026875)
        row = await self.save_and_register(110.656)
        self.assertIsNone(row)
        self.assertEqual(Recordings.select().count(), 0)

    async def test_normal_audio_padding_uses_verified_video_span(self):
        self.probe = media_probe(10)
        await self.save_and_register(10.112)
        row = Recordings.get()
        self.assertAlmostEqual(row.duration, 10)
        self.assertAlmostEqual(row.end_time - row.start_time, 10)
        self.assertEqual(row.keyframes, [0])

    async def test_positive_video_offset_does_not_claim_the_leading_gap(self):
        self.probe = media_probe(0.48)
        self.probe["format"]["start_time"] = "0.5"
        for packet in self.probe["packets"]:
            packet["pts_time"] = str(float(packet["pts_time"]) + 0.5)
            packet["dts_time"] = str(float(packet["dts_time"]) + 0.5)
        await self.save_and_register(0.98)
        row = Recordings.get()
        self.assertAlmostEqual(row.start_time, self.start.timestamp() + 0.5)
        self.assertAlmostEqual(row.end_time, self.start.timestamp() + 0.98)
        self.assertAlmostEqual(row.duration, 0.48)
        self.assertEqual(row.keyframes, [0])

    async def test_source_rejections_also_publish_native_integrity_evidence(self):
        self.maintainer.config.cameras = {
            "front": SimpleNamespace(record=SimpleNamespace(enabled=True))
        }
        self.maintainer.drop_segment = MagicMock()
        for source_info in (
            {"has_valid_video": True, "duration": 15436},
            {"has_valid_video": True, "duration": float("inf")},
            {"has_valid_video": False},
        ):
            with (
                self.subTest(source_info=source_info),
                patch(
                    "frigate.record.maintainer.get_video_properties",
                    AsyncMock(return_value=source_info),
                ),
            ):
                self.maintainer.recordings_publisher.reset_mock()
                row = await self.maintainer.validate_and_move_segment(
                    "front",
                    [],
                    {
                        "start_time": self.start,
                        "cache_path": str(self.cache),
                        "stream_type": "main",
                    },
                )
                self.assertIsNone(row)
                events = self.maintainer.recordings_publisher.publish.call_args_list
                event = next(
                    call.args[0][3] for call in events if call.args[1] == "integrity"
                )
                self.assertIn(event["reason"], {"duration_mismatch", "video_timing"})
                self.assertIsNone(event["video_seconds"])
                self.assertFalse(event["quarantined"])
                json.dumps(event, allow_nan=False)
        self.assertEqual(Recordings.select().count(), 0)

    async def test_valid_short_video_is_preserved_without_fragment_alarm(self):
        self.probe = media_probe(0.48)
        row = await self.save_and_register(0.48)
        self.assertIsNotNone(row)
        self.assertAlmostEqual(Recordings.get().duration, 0.48)
        event = self.maintainer.recordings_publisher.publish.call_args.args
        self.assertEqual(event[0][3]["reason"], "ok")

    async def test_bad_audio_warns_without_erasing_verified_video(self):
        self.probe = media_probe(10, -15414.507125)
        row = await self.save_and_register(10)
        self.assertIsNotNone(row)
        self.assertAlmostEqual(Recordings.get().duration, 10)
        event = self.maintainer.recordings_publisher.publish.call_args.args
        self.assertEqual(event[1], "integrity")
        self.assertEqual(event[0][3]["reason"], "audio_timing")
        self.assertFalse(event[0][3]["quarantined"])

    async def test_probe_failure_preserves_evidence_without_a_db_interval(self):
        self.probe_exit = 1
        self.assertIsNone(await self.save_and_register(10))
        self.assertEqual(Recordings.select().count(), 0)
        event = self.maintainer.recordings_publisher.publish.call_args.args[0][3]
        self.assertEqual(event["reason"], "probe_failed")
        self.assertTrue(event["quarantined"])
        self.assertIsNone(event["video_seconds"])
        self.assertFalse(list(self.recordings.rglob("*.tmp")))

    async def test_notice_transport_failure_does_not_orphan_verified_recording(self):
        self.probe = media_probe(10)
        error = ZMQError(ENOTSOCK, "private transport details")
        self.maintainer.recordings_publisher.publish.side_effect = error
        with self.assertLogs("frigate.record.maintainer", level="WARNING") as logs:
            row = await self.save_and_register(10)
        self.assertIsNotNone(row)
        self.assertEqual(Recordings.select().count(), 1)
        recording = Recordings.get()
        self.assertEqual(recording.duration, 10)
        self.assertEqual(Path(recording.path).read_bytes(), b"complete saved video")
        self.assertFalse(self.cache.exists())
        self.assertFalse(list(self.recordings.rglob("*.tmp")))
        self.assertNotIn(str(error), "\n".join(logs.output))
        self.assertNotIn(str(self.cache), "\n".join(logs.output))

    async def test_quarantine_failure_keeps_original_for_retry_without_orphan(self):
        self.probe_exit = 1
        with patch.object(
            self.maintainer._quarantine(), "preserve", side_effect=OSError("busy")
        ):
            self.assertIsNone(await self.save_and_register(10))
        self.assertEqual(Recordings.select().count(), 0)
        self.assertEqual(self.cache.read_bytes(), b"preserved original video")
        self.assertFalse(list(self.recordings.rglob("*.tmp")))
        event = self.maintainer.recordings_publisher.publish.call_args.args[0][3]
        self.assertEqual(event["reason"], "probe_failed")
        self.assertFalse(event["quarantined"])

    async def test_recovery_registers_only_new_verified_footage(self):
        self.probe = media_probe(0.48, -45799)
        self.assertIsNone(await self.save_and_register(119))
        self.cache.write_bytes(b"new original video")
        self.probe = media_probe(10)
        await self.save_and_register(10)
        self.assertEqual(Recordings.select().count(), 1)
        self.assertEqual(Recordings.get().duration, 10)
        events = self.maintainer.recordings_publisher.publish.call_args_list
        self.assertEqual(events[0].args[0][3]["reason"], "duration_mismatch")
        self.assertEqual(events[-1].args[0][3]["reason"], "ok")
        self.assertEqual(len(list((self.recordings / ".integrity").glob("*.mp4"))), 1)


if __name__ == "__main__":
    unittest.main()
