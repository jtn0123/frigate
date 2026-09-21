"""Fork A6: health checks preserve restart pacing and segment ownership."""

import unittest
from datetime import timedelta
from unittest.mock import MagicMock, patch

from frigate.config.camera.ffmpeg import CameraRoleEnum
from frigate.test.test_record_watchdog import START, FakeDatetime, watchdog


class WatchdogChecksTests(unittest.TestCase):
    def test_segment_updates_ignore_other_cameras_and_clear_missing_latest(self):
        dog = watchdog([])
        dog.segment_subscriber.check_for_update.side_effect = [
            ("recordings/valid", ("other", 999, None)),
            ("recordings/invalid", ("back", 12, None)),
            ("recordings/valid", ("back", 15, None)),
            ("recordings/latest", ("back", None, None)),
            (None, None),
        ]
        dog._drain_segment_updates()
        self.assertEqual(dog.latest_invalid_segment_time, 12)
        self.assertEqual(dog.latest_valid_segment_time, 15)
        self.assertEqual(dog.latest_cache_segment_time, 0)

    def test_dead_capture_logs_once_and_waits_for_backoff(self):
        dog = watchdog([])
        dog.logger = MagicMock()
        dog.capture_thread.is_alive.return_value = False
        dog.logpipe.deque = ["decoder failed"]
        self.assertFalse(dog._check_detect_process(100, False))
        self.assertFalse(dog._check_detect_process(101, False))
        dog.logger.error.assert_called_once()
        dog.reset_capture_thread.assert_not_called()
        self.assertTrue(dog._check_detect_process(110, True))
        dog._check_hwaccel_fallback.assert_called_once_with(["decoder failed"])
        dog.reset_capture_thread.assert_called_once_with(
            terminate=False, lines=["decoder failed"]
        )

    def test_overflow_requires_three_ticks(self):
        dog = watchdog([])
        dog.camera_fps.value = 15
        for _ in range(2):
            self.assertFalse(dog._check_detect_process(START.timestamp(), True))
        self.assertTrue(dog._check_detect_process(START.timestamp(), True))
        dog.reset_capture_thread.assert_called_once_with(
            drain_output=False, cause="exceeded the fps limit"
        )
        self.assertEqual(dog.fps_overflow_count, 0)

    def test_stale_capture_obeys_backoff(self):
        dog = watchdog([])
        self.assertFalse(dog._check_detect_process(START.timestamp() + 21, False))
        dog.reset_capture_thread.assert_not_called()
        self.assertTrue(dog._check_detect_process(START.timestamp() + 22, True))
        dog.reset_capture_thread.assert_called_once_with(
            cause="no frames for 20 seconds"
        )

    def test_record_grace_boundaries_and_stall_reason_priority(self):
        dog = watchdog([])
        dog.record_enable_time = START
        self.assertIsNone(dog._record_stall_reason(START + timedelta(seconds=89)))
        self.assertEqual(
            dog._record_stall_reason(START + timedelta(seconds=90)),
            "No new recording segments were created",
        )
        dog.record_enable_time = None
        dog.record_restart_time = START
        self.assertIsNone(dog._record_stall_reason(START + timedelta(seconds=149)))
        self.assertEqual(
            dog._record_stall_reason(START + timedelta(seconds=150)),
            "No new recording segments were created",
        )
        dog.record_restart_time = None
        for cache, valid, invalid, expected in (
            (150, 150, None, None),
            (151, 151, None, "No new recording segments were created"),
            (0, 151, None, "No new valid recording segments were created"),
            (0, None, 151, "No valid segments created since last invalid segment"),
            (0, 0, 151, None),
            (None, None, None, None),
        ):
            with self.subTest(cache=cache, valid=valid, invalid=invalid):
                dog.latest_cache_segment_time = (
                    0 if cache is None else START.timestamp() - cache
                )
                dog.latest_valid_segment_time = (
                    0 if valid is None else START.timestamp() - valid
                )
                dog.latest_invalid_segment_time = (
                    0 if invalid is None else START.timestamp() - invalid
                )
                self.assertEqual(dog._record_stall_reason(START), expected)

    @patch("frigate.video.ffmpeg.start_or_restart_ffmpeg")
    @patch("frigate.video.ffmpeg.datetime", FakeDatetime)
    def test_exited_record_process_restarts_even_during_startup_grace(self, start):
        FakeDatetime.current = START
        dog = watchdog([])
        dog.record_enable_time = START
        dog.ffmpeg_other_processes[0]["process"].poll.return_value = 1
        dog._check_record_processes(START.timestamp())
        start.assert_called_once()

    @patch("frigate.video.ffmpeg.start_or_restart_ffmpeg")
    @patch("frigate.video.ffmpeg.datetime", FakeDatetime)
    def test_exited_record_process_gets_a_full_stale_window_to_recover(self, start):
        FakeDatetime.current = START
        dog = watchdog([], stale_age=149)
        dog.ffmpeg_other_processes[0]["process"].poll.return_value = 1
        start.return_value.poll.return_value = None
        dog._check_record_processes(START.timestamp())
        start.assert_called_once()
        FakeDatetime.current = START + timedelta(seconds=2)
        dog._check_record_processes(FakeDatetime.current.timestamp())
        start.assert_called_once()
        self.assertEqual(dog.record_restart_time, START)
        FakeDatetime.current = START + timedelta(seconds=150)
        dog._check_record_processes(FakeDatetime.current.timestamp())
        self.assertEqual(start.call_count, 2)

    @patch("frigate.video.ffmpeg.start_or_restart_ffmpeg")
    @patch("frigate.video.ffmpeg.datetime", FakeDatetime)
    def test_exited_audio_process_does_not_change_record_grace(self, start):
        FakeDatetime.current = START
        dog = watchdog([])
        process = dog.ffmpeg_other_processes[0]
        process["roles"] = [CameraRoleEnum.audio]
        process["process"].poll.return_value = 1
        dog._check_record_processes(START.timestamp())
        start.assert_called_once()
        self.assertIsNone(dog.record_restart_time)

    @patch("frigate.video.ffmpeg.start_or_restart_ffmpeg")
    @patch("frigate.video.ffmpeg.datetime", FakeDatetime)
    def test_stale_and_exited_record_process_restarts_only_once(self, start):
        FakeDatetime.current = START
        dog = watchdog([])
        dog.ffmpeg_other_processes[0]["process"].poll.return_value = 1
        dog._check_record_processes(START.timestamp())
        start.assert_called_once()
        self.assertEqual(dog.record_restart_time, START)
