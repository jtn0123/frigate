"""Recording notices distinguish corrupted media from live capture health."""

import unittest
from unittest.mock import Mock

from frigate.fork.recording_integrity_status import RecordingIntegrityStatus


class TestRecordingIntegrityStatus(unittest.TestCase):
    def setUp(self):
        self.raise_notice = Mock()
        self.clock_now = 1000
        self.status = RecordingIntegrityStatus(
            self.raise_notice, elapsed_clock=lambda: self.clock_now
        )

    def observe(self, reason, at=1000, stream="main", **detail):
        self.clock_now = at
        self.status.update(
            (
                "side",
                stream,
                at,
                {
                    "reason": reason,
                    "audio_status": "ok",
                    "quarantined": False,
                    "video_seconds": 10,
                    **detail,
                },
            ),
            at,
            ["side"],
        )

    def test_video_mismatch_raises_camera_scoped_native_warning(self):
        self.observe("duration_mismatch")
        self.raise_notice.assert_called_once_with(
            "recording_video_integrity",
            scope="side",
            params={"reason": "duration_mismatch"},
        )

    def test_audio_warning_does_not_claim_missing_video(self):
        self.observe("audio_timing", audio_status="invalid")
        self.raise_notice.assert_called_once_with(
            "recording_audio_integrity", scope="side", params={"reason": "audio_timing"}
        )

    def test_fragment_storm_is_coalesced_and_reason_change_is_visible(self):
        for at in range(1000, 1299):
            self.observe("video_timing", at)
        self.assertEqual(self.raise_notice.call_count, 1)
        self.observe("video_timing", 1300)
        self.assertEqual(self.raise_notice.call_count, 2)
        self.observe("audio_timing", 1301)
        self.assertEqual(self.raise_notice.call_count, 3)

    def test_alternating_corruption_reasons_remain_bounded(self):
        for at in range(1000, 1299):
            self.observe(["video_timing", "probe_failed", "audio_timing"][at % 3], at)
        self.assertEqual(self.raise_notice.call_count, 2)

    def test_malformed_success_cannot_reset_the_episode(self):
        for detail in (
            {"audio_status": []},
            {"video_seconds": None},
            {"video_seconds": float("inf")},
            {"video_seconds": 10**1000},
            {"video_seconds": True},
            {"quarantined": True},
        ):
            with self.subTest(field=next(iter(detail))):
                self.raise_notice.reset_mock()
                self.status = RecordingIntegrityStatus(
                    self.raise_notice, elapsed_clock=lambda: self.clock_now
                )
                self.observe("video_timing")
                for at in range(1010, 1081, 10):
                    self.observe("ok", at, **detail)
                self.observe("video_timing", 1090)
                self.assertEqual(self.raise_notice.call_count, 1)

    def test_single_success_sub_stream_or_unknown_cannot_reset_episode(self):
        self.observe("duration_mismatch")
        self.observe("ok", 1010)
        self.observe("ok", 1015, stream="sub")
        self.observe("ok", 1020, audio_status="unknown")
        self.observe("duration_mismatch", 1075)
        self.assertEqual(self.raise_notice.call_count, 1)

    def test_sustained_verified_recovery_allows_new_episode(self):
        self.observe("video_timing")
        for at in range(1010, 1081, 10):
            self.observe("ok", at)
        self.assertEqual(self.raise_notice.call_count, 1)
        self.observe("video_timing", 1090)
        self.assertEqual(self.raise_notice.call_count, 2)

    def test_clock_rollback_does_not_hide_recovery_and_new_corruption(self):
        self.observe("video_timing")
        for wall in range(100, 171, 10):
            self.clock_now = 1010 + wall - 100
            self.status.update(
                (
                    "side",
                    "main",
                    wall,
                    {
                        "reason": "ok",
                        "audio_status": "ok",
                        "video_seconds": 10,
                        "quarantined": False,
                    },
                ),
                wall,
                ["side"],
            )
        self.clock_now = 1090
        self.status.update(
            ("side", "main", 180, {"reason": "video_timing"}), 180, ["side"]
        )
        self.assertEqual(self.raise_notice.call_count, 2)

    def test_clock_jump_cannot_bypass_monotonic_notice_cooldown(self):
        self.observe("video_timing")
        self.clock_now = 1010
        self.status.update(
            ("side", "main", 9000, {"reason": "video_timing"}), 9000, ["side"]
        )
        self.assertEqual(self.raise_notice.call_count, 1)

    def test_unobserved_gap_does_not_count_as_verified_recovery(self):
        self.observe("video_timing")
        self.observe("ok", 1010)
        self.observe("ok", 1110)
        self.observe("video_timing", 1120)
        self.assertEqual(self.raise_notice.call_count, 1)

    def test_unsupported_stale_future_or_reordered_observations_are_ignored(self):
        for payload in (
            None,
            ("side", "main", 1000),
            ("other", "main", 1000, {"reason": "video_timing"}),
            ("side", "main", True, {"reason": "video_timing"}),
            ("side", "main", float("nan"), {"reason": "video_timing"}),
            ("side", "main", 10**1000, {"reason": "video_timing"}),
            ("side", "main", 1001, {"reason": "video_timing"}),
            ("side", "main", 879, {"reason": "video_timing"}),
            ("side", "main", 1000, {"reason": "secret-or-path"}),
        ):
            self.status.update(payload, 1000, ["side"])
        self.raise_notice.assert_not_called()
        self.observe("video_timing")
        self.status.update(
            ("side", "main", 999, {"reason": "audio_missing"}), 1001, ["side"]
        )
        self.assertEqual(self.raise_notice.call_count, 1)

    def test_removed_cameras_do_not_keep_unbounded_state(self):
        self.observe("video_timing")
        self.status.update(None, 1000, [])
        self.assertEqual(self.status._episodes, {})

    def test_untrusted_payload_is_not_copied_into_notices(self):
        self.observe(
            "probe_failed", raw_error="private-path", camera_password="private"
        )
        self.assertEqual(
            self.raise_notice.call_args.kwargs["params"], {"reason": "probe_failed"}
        )


if __name__ == "__main__":
    unittest.main()
