"""SV14: bound final-media validation and retain only verified video coverage."""

import asyncio
import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from frigate.fork.recording_integrity import (
    INTEGRITY_REASONS,
    RecordingIntegrity,
    inspect_recording,
    probe_recording_integrity,
)
from frigate.test.test_record_final_integrity import ProbeProcess, media_probe


class TestRecordingPacketIntegrity(unittest.TestCase):
    def test_observed_camera_header_spans_accept_normal_aac_padding(self):
        # Packet geometry is synthetic; these spans and offsets reproduce the
        # seven-camera saved-file header sample, including Backyard's sparse AAC.
        cases = (
            (9.994, 10.017, 0.033, 9.984, "ok"),
            (10.0, 10.018, 0.034, 9.984, "ok"),
            (8.001, 8.091, 0.027, 8.064, "ok"),
            (10.029, 10.153, 0.041, 10.112, "ok"),
            (9.978056, 10.048, 0, 0.064, "audio_missing"),
            (10.08, 10.123, 0.011, 10.112, "ok"),
        )
        for video, source, audio_start, audio, expected in cases:
            with self.subTest(video=video, audio=audio):
                data = media_probe(video, audio_start)
                video_packets = data["packets"][:-1]
                frame_duration = video / len(video_packets)
                for index, packet in enumerate(video_packets):
                    packet.update(
                        pts_time=str(index * frame_duration),
                        dts_time=str(index * frame_duration),
                        duration_time=str(frame_duration),
                    )
                data["packets"] = video_packets + [
                    {
                        "stream_index": 1,
                        "pts_time": str(audio_start + index * 0.064),
                        "dts_time": str(audio_start + index * 0.064),
                        "duration_time": "0.064",
                    }
                    for index in range(round(audio / 0.064))
                ]
                result = inspect_recording(data, source, expected_audio=True)
                self.assertEqual(result.reason, expected)
                self.assertTrue(result.video_verified)
                self.assertAlmostEqual(result.video_seconds, video)

    def test_normal_video_without_audio_is_valid(self):
        result = inspect_recording(media_probe(10), 10.1)
        self.assertTrue(result.video_verified)
        self.assertEqual(result.audio_status, "not_present")
        self.assertFalse(result.audio_present)
        self.assertEqual(result.keyframes, (0,))

    def test_normal_aac_with_encoder_priming_is_valid(self):
        data = media_probe(10, 0)
        data["packets"] = data["packets"][:-1] + [
            {
                "stream_index": 1,
                "pts_time": str(index * 0.064 - 0.032),
                "dts_time": str(index * 0.064 - 0.032),
                "duration_time": "0.064",
            }
            for index in range(157)
        ]
        result = inspect_recording(data, 10)
        self.assertEqual(result.reason, "ok")
        self.assertEqual(result.audio_status, "ok")
        self.assertTrue(result.audio_present)

    def test_one_audio_packet_cannot_claim_a_complete_ten_second_track(self):
        result = inspect_recording(media_probe(10, 0), 10)
        self.assertTrue(result.video_verified)
        self.assertEqual(result.reason, "audio_missing")

    def test_sparse_audio_endpoints_cannot_claim_the_missing_middle(self):
        data = media_probe(10, 0)
        last = copy.deepcopy(data["packets"][-1])
        last.update(pts_time="9.936", dts_time="9.936")
        data["packets"].append(last)
        result = inspect_recording(data, 10)
        self.assertEqual(result.reason, "audio_missing")
        self.assertTrue(result.video_verified)

    def test_duplicate_audio_packets_do_not_inflate_track_coverage(self):
        data = media_probe(10, 0)
        data["packets"].extend([copy.deepcopy(data["packets"][-1])] * 200)
        self.assertEqual(inspect_recording(data, 10).reason, "audio_missing")

    def test_audio_internal_gap_warns_despite_mostly_complete_track(self):
        data = media_probe(10, 0)
        data["packets"] = data["packets"][:-1] + [
            {
                "stream_index": 1,
                "pts_time": str(index * 0.064),
                "dts_time": str(index * 0.064),
                "duration_time": "0.064",
            }
            for index in range(157)
            if not 50 <= index <= 55
        ]
        self.assertEqual(inspect_recording(data, 10).reason, "audio_missing")

    def test_negative_audio_hours_do_not_remove_verified_video(self):
        result = inspect_recording(media_probe(10, -15414.507125), 10)
        self.assertEqual(result.video_seconds, 10)
        self.assertTrue(result.video_verified)
        self.assertEqual(result.reason, "audio_timing")

    def test_missing_expected_audio_is_distinct_from_no_audio_recording(self):
        result = inspect_recording(media_probe(10), 10, expected_audio=True)
        self.assertEqual(result.reason, "audio_missing")
        self.assertTrue(result.video_verified)
        self.assertFalse(result.audio_present)

    def test_empty_declared_audio_track_is_missing(self):
        data = media_probe(10, 0)
        data["packets"].pop()
        self.assertEqual(inspect_recording(data, 10).reason, "audio_missing")

    def test_short_valid_video_and_audio_are_not_fragment_faults(self):
        self.assertEqual(inspect_recording(media_probe(0.04, 0), 0.064).reason, "ok")

    def test_b_frame_pts_reordering_is_not_a_timestamp_failure(self):
        data = media_probe(0.48)
        data["packets"][1]["pts_time"], data["packets"][2]["pts_time"] = (
            data["packets"][2]["pts_time"],
            data["packets"][1]["pts_time"],
        )
        self.assertEqual(inspect_recording(data, 0.48).reason, "ok")

    def test_discontinuous_video_cannot_fill_missing_wall_time(self):
        for field, value in (("pts_time", "45"), ("dts_time", "-45")):
            with self.subTest(field=field):
                data = media_probe(0.48)
                data["packets"][5][field] = value
                result = inspect_recording(data, 0.48)
                self.assertFalse(result.video_verified)
                self.assertEqual(result.reason, "video_timing")

    def test_nonfinite_missing_and_negative_timing_fail_closed(self):
        for field in ("pts_time", "dts_time", "duration_time"):
            for value in (None, "NaN", "Infinity", True):
                with self.subTest(field=field, value=value):
                    data = media_probe()
                    data["packets"][0][field] = value
                    self.assertFalse(inspect_recording(data, 0.48).video_verified)
        for value in (0, -1, float("nan"), float("inf")):
            self.assertEqual(
                inspect_recording(media_probe(), value).reason, "duration_mismatch"
            )

    def test_probe_shape_and_resource_bounds_are_explicit(self):
        cases = [None, {}, {"streams": [], "packets": []}]
        data = media_probe()
        bad_packet = copy.deepcopy(data)
        bad_packet["packets"][0] = "invalid"
        cases.append(bad_packet)
        bad_index = copy.deepcopy(data)
        bad_index["streams"][0]["index"] = "0"
        cases.append(bad_index)
        for case in cases:
            with self.subTest(case=case):
                result = inspect_recording(case, 0.48)
                self.assertFalse(result.video_verified)
                self.assertIn(result.reason, INTEGRITY_REASONS)
        with patch("frigate.fork.recording_integrity.PROBE_MAX_PACKETS", 2):
            self.assertEqual(inspect_recording(data, 0.48).reason, "probe_limit")
        data["streams"] *= 9
        self.assertEqual(inspect_recording(data, 0.48).reason, "probe_limit")

    def test_unusable_video_start_and_duration_are_rejected(self):
        for offset in (-2, -0.5, 601):
            data = media_probe()
            for packet in data["packets"]:
                packet["pts_time"] = str(float(packet["pts_time"]) + offset)
                packet["dts_time"] = str(float(packet["dts_time"]) + offset)
            self.assertEqual(inspect_recording(data, 0.48).reason, "video_timing")

    def test_positive_video_offset_must_agree_with_source_end(self):
        data = media_probe()
        data["format"]["start_time"] = "0.5"
        for packet in data["packets"]:
            packet["pts_time"] = str(float(packet["pts_time"]) + 0.5)
            packet["dts_time"] = str(float(packet["dts_time"]) + 0.5)
        self.assertEqual(inspect_recording(data, 0.48).reason, "duration_mismatch")
        result = inspect_recording(data, 0.98)
        self.assertEqual(result.reason, "ok")
        self.assertAlmostEqual(result.video_seconds, 0.48)
        self.assertAlmostEqual(result.video_start, 0.5)

    def test_earlier_audio_origin_cannot_shift_existing_relative_seek_mapping(self):
        data = media_probe(0.48, 0)
        for packet in data["packets"]:
            if packet["stream_index"] == 0:
                packet["pts_time"] = str(float(packet["pts_time"]) + 0.5)
                packet["dts_time"] = str(float(packet["dts_time"]) + 0.5)
        result = inspect_recording(data, 0.98)
        self.assertEqual(result.reason, "video_timing")
        self.assertFalse(result.video_verified)

    def test_unknown_or_nonfinite_file_origin_cannot_establish_video_mapping(self):
        for value in (None, {}, {"start_time": "NaN"}, {"start_time": True}):
            data = media_probe()
            data["format"] = value
            self.assertEqual(inspect_recording(data, 0.48).reason, "video_timing")


class TestBoundedRecordingProbe(unittest.IsolatedAsyncioTestCase):
    async def test_real_aac_and_b_frame_video_pass_without_decoding_probe(self):
        ffmpeg = Path("/usr/lib/ffmpeg/8.0/bin/ffmpeg")
        if not ffmpeg.is_file():
            ffmpeg = Path(shutil.which("ffmpeg") or str(ffmpeg))
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "normal-aac.mp4")
            process = await asyncio.create_subprocess_exec(
                str(ffmpeg),
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=size=160x120:rate=25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=16000",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                path,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, errors = await asyncio.wait_for(process.communicate(), 10)
            self.assertEqual(process.returncode, 0, errors)
            saved = str(Path(directory) / "saved-faststart.mp4")
            process = await asyncio.create_subprocess_exec(
                str(ffmpeg),
                "-y",
                "-i",
                path,
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                saved,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, errors = await asyncio.wait_for(process.communicate(), 10)
            self.assertEqual(process.returncode, 0, errors)
            result = await probe_recording_integrity(
                str(ffmpeg.with_name("ffprobe")), saved, 1.024, expected_audio=True
            )
        self.assertEqual(result.reason, "ok")
        self.assertAlmostEqual(result.video_seconds, 1)
        self.assertTrue(result.audio_present)

    async def test_origin_normalization_preserves_original_on_failed_or_changed_output(
        self,
    ):
        original = media_probe(0.48, 0)
        for packet in original["packets"]:
            if packet["stream_index"] == 0:
                packet["pts_time"] = str(float(packet["pts_time"]) + 0.064)
                packet["dts_time"] = str(float(packet["dts_time"]) + 0.064)
        shorter = media_probe(0.44)
        lost_keyframe = media_probe(0.48)
        lost_keyframe["packets"][0]["flags"] = "__"
        for exit_code, output in (
            (1, None),
            (0, shorter),
            (0, lost_keyframe),
            (0, original),
        ):
            with self.subTest(exit_code=exit_code, output=output):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "saved.mp4.tmp"
                    path.write_bytes(b"original footage")
                    calls = 0

                    async def spawn(*args, **kwargs):
                        nonlocal calls
                        calls += 1
                        if calls == 1:
                            return ProbeProcess(json.dumps(original).encode())
                        if calls == 2:
                            Path(args[-1]).write_bytes(b"uncertain remux")
                            return ProbeProcess(returncode=exit_code)
                        return ProbeProcess(json.dumps(output).encode())

                    with patch("asyncio.create_subprocess_exec", side_effect=spawn):
                        result = await probe_recording_integrity(
                            "ffprobe", str(path), 0.544, ffmpeg="ffmpeg"
                        )
                    self.assertFalse(result.video_verified)
                    self.assertEqual(path.read_bytes(), b"original footage")
                    self.assertFalse(Path(f"{path}.normalized.tmp").exists())

    async def test_origin_normalization_timeout_kills_process_and_keeps_original(self):
        original = media_probe(0.48)
        for packet in original["packets"]:
            packet["pts_time"] = str(float(packet["pts_time"]) + 0.064)
            packet["dts_time"] = str(float(packet["dts_time"]) + 0.064)
        process = ProbeProcess(returncode=None)
        process.wait = AsyncMock(side_effect=[TimeoutError, 0])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.mp4.tmp"
            path.write_bytes(b"original footage")
            with patch(
                "asyncio.create_subprocess_exec",
                side_effect=[
                    ProbeProcess(json.dumps(original).encode()),
                    process,
                ],
            ):
                result = await probe_recording_integrity(
                    "ffprobe", str(path), 0.544, ffmpeg="ffmpeg"
                )
            self.assertEqual(result.reason, "probe_timeout")
            self.assertEqual(process.returncode, -9)
            self.assertEqual(path.read_bytes(), b"original footage")

    async def test_success_uses_file_only_packet_scan_without_decoding(self):
        process = ProbeProcess(json.dumps(media_probe()).encode())
        with patch("asyncio.create_subprocess_exec", return_value=process) as spawn:
            result = await probe_recording_integrity("ffprobe", "/tmp/test.mp4", 0.48)
        self.assertEqual(result.reason, "ok")
        args = spawn.call_args.args
        self.assertEqual(args[args.index("-protocol_whitelist") + 1], "file")
        self.assertIn("-show_packets", args)
        self.assertNotIn("-show_frames", args)

    async def test_oversized_output_is_killed_before_unbounded_collection(self):
        process = ProbeProcess(b"x" * 100, returncode=None)
        with (
            patch("asyncio.create_subprocess_exec", return_value=process),
            patch("frigate.fork.recording_integrity.PROBE_MAX_BYTES", 64),
        ):
            result = await probe_recording_integrity("ffprobe", "/tmp/test.mp4", 1)
        self.assertEqual(result.reason, "probe_limit")
        self.assertEqual(process.returncode, -9)

    async def test_timeout_kills_and_drains_the_probe(self):
        process = ProbeProcess(returncode=None)
        process.stdout = asyncio.StreamReader()
        with (
            patch("asyncio.create_subprocess_exec", return_value=process),
            patch("frigate.fork.recording_integrity.PROBE_TIMEOUT", 0.01),
        ):
            result = await probe_recording_integrity("ffprobe", "/tmp/test.mp4", 1)
        self.assertEqual(result.reason, "probe_timeout")
        self.assertEqual(process.returncode, -9)

    async def test_failed_and_malformed_probes_do_not_claim_coverage(self):
        for process in (ProbeProcess(returncode=1), ProbeProcess(b"invalid")):
            with patch("asyncio.create_subprocess_exec", return_value=process):
                result = await probe_recording_integrity("ffprobe", "/tmp/test.mp4", 1)
            self.assertEqual(result, RecordingIntegrity("probe_failed"))
        with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
            result = await probe_recording_integrity("missing", "/tmp/test.mp4", 1)
        self.assertEqual(result.reason, "probe_failed")

    async def test_cancellation_stops_probe_and_propagates(self):
        process = ProbeProcess(returncode=None)
        process.stdout = asyncio.StreamReader()
        with patch("asyncio.create_subprocess_exec", return_value=process):
            task = asyncio.create_task(
                probe_recording_integrity("ffprobe", "/tmp/test.mp4", 1)
            )
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(process.returncode, -9)


class SignaledProbeReader(asyncio.StreamReader):
    """Signal when a subprocess output read starts, without polling or sleeps."""

    def __init__(self, started):
        super().__init__()
        self.started = started

    async def read(self, n=-1):
        self.started.set()
        return await super().read(n)


class PendingNormalizationProcess(ProbeProcess):
    """Keep a synthetic child alive until the production cleanup kills it."""

    def __init__(self, output=b""):
        super().__init__(returncode=None)
        self.started = asyncio.Event()
        self.stopped = asyncio.Event()
        self.stdout = SignaledProbeReader(self.started)
        self.stdout.feed_data(output)
        self.kill_count = 0
        self.drain_count = 0
        self.wait_count = 0

    async def wait(self):
        self.wait_count += 1
        self.started.set()
        await self.stopped.wait()
        return self.returncode

    async def communicate(self):
        self.drain_count += 1
        await self.stopped.wait()
        return b"", b""

    def kill(self):
        super().kill()
        self.kill_count += 1
        self.stdout.feed_eof()
        self.stopped.set()


class TestRecordingNormalizationCleanup(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "saved.mp4.tmp"
        self.path.write_bytes(b"original footage")
        self.normalized = Path(f"{self.path}.normalized.tmp")
        original = media_probe(0.48)
        for packet in original["packets"]:
            packet["pts_time"] = str(float(packet["pts_time"]) + 0.064)
            packet["dts_time"] = str(float(packet["dts_time"]) + 0.064)
        self.original_probe = json.dumps(original).encode()

    def start_normalization(self, stage, output=b""):
        running = PendingNormalizationProcess(output)
        calls = []

        async def spawn(*args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                return ProbeProcess(self.original_probe)
            if len(calls) == 2:
                self.assertEqual(args[0], "ffmpeg")
                self.normalized.write_bytes(b"unverified normalized output")
                return running if stage == "normalizer" else ProbeProcess()
            self.assertEqual(len(calls), 3, "Normalization must not recurse")
            self.assertEqual(args[0], "ffprobe")
            self.assertEqual(args[-1], str(self.normalized))
            return running

        self.enterContext(patch("asyncio.create_subprocess_exec", side_effect=spawn))
        task = asyncio.create_task(
            probe_recording_integrity("ffprobe", str(self.path), 0.544, ffmpeg="ffmpeg")
        )

        async def stop_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        self.addAsyncCleanup(stop_task)
        return task, running, calls

    def assert_original_preserved(self, running):
        self.assertEqual(running.returncode, -9)
        self.assertEqual(running.kill_count, 1)
        self.assertEqual(self.path.read_bytes(), b"original footage")
        self.assertFalse(self.normalized.exists())
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    async def test_cancellation_during_normalizer_kills_child_and_removes_output(self):
        task, running, calls = self.start_normalization("normalizer")
        await asyncio.wait_for(running.started.wait(), 1)
        self.assertTrue(self.normalized.exists())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assert_original_preserved(running)
        self.assertEqual(running.wait_count, 2)
        self.assertEqual(len(calls), 2)

    async def test_cancellation_during_second_probe_kills_and_drains_child(self):
        task, running, calls = self.start_normalization("second_probe")
        await asyncio.wait_for(running.started.wait(), 1)
        self.assertTrue(self.normalized.exists())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assert_original_preserved(running)
        self.assertEqual(running.drain_count, 1)
        self.assertEqual(len(calls), 3)

    async def test_second_probe_timeout_preserves_original_and_cleans_output(self):
        with patch("frigate.fork.recording_integrity.PROBE_TIMEOUT", 0.05):
            task, running, calls = self.start_normalization("second_probe")
            await asyncio.wait_for(running.started.wait(), 1)
            result = await asyncio.wait_for(task, 1)
        self.assertFalse(result.video_verified)
        self.assert_original_preserved(running)
        self.assertEqual(running.drain_count, 1)
        self.assertEqual(len(calls), 3)

    async def test_second_probe_output_limit_preserves_original_and_cleans_output(self):
        with patch("frigate.fork.recording_integrity.PROBE_MAX_BYTES", 4096):
            task, running, calls = self.start_normalization("second_probe", b"x" * 4097)
            await asyncio.wait_for(running.started.wait(), 1)
            result = await asyncio.wait_for(task, 1)
        self.assertFalse(result.video_verified)
        self.assert_original_preserved(running)
        self.assertEqual(running.drain_count, 1)
        self.assertEqual(len(calls), 3)
