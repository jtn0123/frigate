"""Fork A6: health checks preserve restart pacing and segment ownership."""

import unittest
from unittest.mock import MagicMock, patch

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
    def test_stale_and_exited_record_process_restarts_only_once(self, start):
        FakeDatetime.current = START
        dog = watchdog([])
        dog.ffmpeg_other_processes[0]["process"].poll.return_value = 1
        dog._check_record_processes(START.timestamp())
        start.assert_called_once()
        self.assertEqual(dog.record_restart_time, START)
