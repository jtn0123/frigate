"""Tests for probing audio durations missing from older recordings (B46)."""

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from peewee import DatabaseError

from frigate.api.media import _vod_response
from frigate.fork import recording_audio_backfill
from frigate.fork.recording_audio_backfill import backfill_audio_duration
from frigate.fork.recording_integrity import RecordingIntegrity
from frigate.models import Recordings
from frigate.test.test_recording_coverage import CoverageDbTestCase
from frigate.util.recording_coverage import realized_timeline, resolve_coverage

PROBE = "frigate.fork.recording_audio_backfill.probe_recording_integrity"
KEYFRAMES = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]


def _short_audio(seconds=0.064):
    return RecordingIntegrity("audio_missing", 10.0, audio_seconds=seconds)


class BackfillTestCase(CoverageDbTestCase):
    def setUp(self):
        super().setUp()
        recording_audio_backfill._cache.clear()
        self.addCleanup(recording_audio_backfill._cache.clear)

    def _insert_pair(self, first_audio_duration=None):
        # two Reolink segments whose audio is cut to 0.064s
        for id, start, audio_duration in (
            ("m1", 1000.0, first_audio_duration),
            ("m2", 1010.0, None),
        ):
            self._insert(
                id,
                start,
                start + 10.0,
                "main",
                has_audio=True,
                audio_codec="aac",
                audio_rate=16000,
                keyframes=KEYFRAMES,
                audio_duration=audio_duration,
            )

    def _clips(self, start, end):
        response = _vod_response("front_door", start, end)
        return json.loads(response.body)["sequences"][0]["clips"]

    def _stored(self, id):
        return Recordings.get(Recordings.id == id).audio_duration


class TestVodAudioBackfill(BackfillTestCase):
    def test_short_audio_mid_segment_is_skipped_and_stored(self):
        self._insert_pair()
        with patch(PROBE, AsyncMock(return_value=_short_audio())) as probe:
            clips = self._clips(1005.0, 1020.0)
            timeline = realized_timeline(
                resolve_coverage("front_door", 1005.0, 1020.0), None
            )

        assert [c["path"] for c in clips] == ["/tmp/m2.mp4"]
        assert [t["duration"] for t in timeline] == [0, 10000]
        # only the mid-segment row is probed, and only once
        probe.assert_awaited_once()
        assert probe.await_args.args[1:] == ("/tmp/m1.mp4", 10.0, True)
        assert self._stored("m1") == 0.064
        assert self._stored("m2") is None

    def test_probe_failure_keeps_clip(self):
        self._insert_pair()
        failed = RecordingIntegrity("probe_failed")
        with patch(PROBE, AsyncMock(return_value=failed)) as probe:
            clips = self._clips(1005.0, 1020.0)

        probe.assert_awaited_once()
        assert [c["path"] for c in clips] == ["/tmp/m1.mp4", "/tmp/m2.mp4"]
        assert clips[0]["clipFrom"] == 5000
        assert self._stored("m1") is None

    def test_clip_from_segment_start_is_not_probed(self):
        self._insert_pair()
        with patch(PROBE, AsyncMock(return_value=_short_audio())) as probe:
            clips = self._clips(1000.0, 1020.0)

        probe.assert_not_awaited()
        assert len(clips) == 2
        assert self._stored("m1") is None

    def test_known_duration_is_not_probed(self):
        self._insert_pair(first_audio_duration=0.064)
        with patch(PROBE, AsyncMock(return_value=_short_audio())) as probe:
            clips = self._clips(1005.0, 1020.0)

        probe.assert_not_awaited()
        assert [c["path"] for c in clips] == ["/tmp/m2.mp4"]

    def test_audio_left_after_clip_start_keeps_clip(self):
        self._insert_pair()
        with patch(PROBE, AsyncMock(return_value=_short_audio(9.5))):
            clips = self._clips(1005.0, 1020.0)

        assert len(clips) == 2
        assert self._stored("m1") == 9.5

    def test_sole_clip_is_not_probed(self):
        # alone in its sequence the clip has nothing to mismatch against
        self._insert_pair()
        with patch(PROBE, AsyncMock(return_value=_short_audio())) as probe:
            clips = self._clips(1005.0, 1009.0)

        probe.assert_not_awaited()
        assert clips[0]["path"] == "/tmp/m1.mp4"


class TestBackfillAudioDuration(BackfillTestCase):
    def setUp(self):
        super().setUp()
        self._insert_pair()
        self.row = SimpleNamespace(id="m1", path="/tmp/m1.mp4", duration=10.0)

    def test_failed_probe_is_remembered(self):
        failed = RecordingIntegrity("probe_timeout")
        with patch(PROBE, AsyncMock(return_value=failed)) as probe:
            assert backfill_audio_duration(self.row) is None
            assert backfill_audio_duration(self.row) is None

        probe.assert_awaited_once()

    def test_store_failure_still_returns_duration(self):
        with (
            patch(PROBE, AsyncMock(return_value=_short_audio())),
            patch.object(Recordings, "update", side_effect=DatabaseError("locked")),
        ):
            assert backfill_audio_duration(self.row) == 0.064

        assert self._stored("m1") is None

    def test_event_loop_is_not_blocked(self):
        async def call():
            return backfill_audio_duration(self.row)

        with patch(PROBE, AsyncMock(return_value=_short_audio())) as probe:
            assert asyncio.run(call()) is None
            # skipped calls are not remembered, so a worker thread still probes
            assert backfill_audio_duration(self.row) == 0.064

        probe.assert_awaited_once()

    def test_cache_is_bounded(self):
        other = SimpleNamespace(id="m2", path="/tmp/m2.mp4", duration=10.0)
        with (
            patch.object(recording_audio_backfill, "_CACHE_LIMIT", 1),
            patch(PROBE, AsyncMock(return_value=_short_audio())) as probe,
        ):
            backfill_audio_duration(self.row)
            backfill_audio_duration(other)
            backfill_audio_duration(self.row)

        assert probe.await_count == 3
        assert list(recording_audio_backfill._cache) == ["/tmp/m1.mp4"]


if __name__ == "__main__":
    unittest.main()
