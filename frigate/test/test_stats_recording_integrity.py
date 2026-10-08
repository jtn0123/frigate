"""The stats thread consumes recording integrity independently of browsers."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from frigate.fork.recording_integrity_status import (
    MAX_EVENTS_PER_TICK,
    RecordingIntegrityStatus,
)
from frigate.stats.emitter import StatsEmitter


class TestStatsRecordingIntegrity(unittest.TestCase):
    def setUp(self):
        self.emitter = StatsEmitter.__new__(StatsEmitter)
        self.emitter.config = SimpleNamespace(cameras={"side": object()})
        self.raise_notice = Mock()
        self.emitter.recording_integrity_status = RecordingIntegrityStatus(
            self.raise_notice
        )
        self.emitter.recording_integrity_subscriber = Mock()

    def test_native_recording_event_becomes_camera_notice(self):
        self.emitter.recording_integrity_subscriber.check_for_update.side_effect = [
            (
                "recordings/integrity",
                ("side", "main", 1000, {"reason": "duration_mismatch"}),
            ),
            (None, None),
        ]
        self.emitter._update_recording_integrity(1000)
        self.raise_notice.assert_called_once_with(
            "recording_video_integrity",
            scope="side",
            params={"reason": "duration_mismatch"},
        )
        self.emitter.recording_integrity_subscriber.check_for_update.assert_called_with(
            timeout=0
        )

    def test_unrelated_internal_topic_cannot_fabricate_notice(self):
        self.emitter.recording_integrity_subscriber.check_for_update.side_effect = [
            (
                "recordings/saved",
                ("side", "main", 1000, {"reason": "duration_mismatch"}),
            ),
            (None, None),
        ]
        self.emitter._update_recording_integrity(1000)
        self.raise_notice.assert_not_called()

    def test_flood_drain_is_bounded_and_never_waits(self):
        self.emitter.recording_integrity_subscriber.check_for_update.return_value = (
            "recordings/integrity",
            ("side", "main", 1000, {"reason": "video_timing"}),
        )
        self.emitter._update_recording_integrity(1000)
        self.assertEqual(
            self.emitter.recording_integrity_subscriber.check_for_update.call_count,
            MAX_EVENTS_PER_TICK,
        )
        self.assertEqual(self.raise_notice.call_count, 1)

    def test_not_started_subscriber_is_unavailable(self):
        self.emitter.recording_integrity_subscriber = None
        self.emitter._update_recording_integrity(1000)
        self.raise_notice.assert_not_called()


if __name__ == "__main__":
    unittest.main()
