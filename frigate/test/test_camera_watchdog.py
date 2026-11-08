"""Tests for per stream recording health tracking in the camera watchdog."""

import subprocess as sp
import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, call, patch

from frigate.config import FrigateConfig
from frigate.config.camera.ffmpeg import CameraRoleEnum
from frigate.const import STREAM_TYPE_MAIN, STREAM_TYPE_SUB
from frigate.video.ffmpeg import (
    HEARTBEAT_SECONDS,
    CameraWatchdog,
    _check_record_staleness,
    _send_roles_offline,
)


def build_watchdog(
    sub_enabled: bool = True, output_args: dict | None = None
) -> CameraWatchdog:
    config = FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "front_door": {
                    "ffmpeg": {
                        "output_args": output_args or {},
                        "inputs": [
                            {
                                "path": "rtsp://10.0.0.1:554/video",
                                "roles": ["record"],
                            },
                            {
                                "path": "rtsp://10.0.0.1:554/video2",
                                "roles": ["detect", "record_sub"],
                            },
                        ],
                    },
                    "record": {
                        "enabled": True,
                        "sub": {"enabled": sub_enabled},
                    },
                }
            },
        }
    )
    camera_config = config.cameras["front_door"]

    with (
        patch("frigate.video.ffmpeg.LogPipe"),
        patch("frigate.video.ffmpeg.InterProcessRequestor"),
        patch("frigate.video.ffmpeg.RecordingsDataSubscriber"),
        patch("frigate.video.ffmpeg.CameraConfigUpdateSubscriber"),
    ):
        watchdog = CameraWatchdog(
            camera_config,
            1,
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
        )

    watchdog.requestor = MagicMock()
    return watchdog


class TestCameraWatchdogStop(unittest.TestCase):
    def _build_stopping_watchdog(self, capture_reading: bool) -> CameraWatchdog:
        watchdog = build_watchdog()
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.capture_thread.is_alive.return_value = capture_reading
        return watchdog

    def test_live_capture_thread_terminates_without_reading_stdout(self):
        watchdog = self._build_stopping_watchdog(capture_reading=True)
        process = watchdog.ffmpeg_detect_process

        with patch("frigate.video.ffmpeg.stop_ffmpeg") as stop_ffmpeg:
            watchdog.stop_all_ffmpeg()

        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=30)
        process.kill.assert_not_called()
        process.communicate.assert_not_called()
        stop_ffmpeg.assert_not_called()
        self.assertIsNone(watchdog.ffmpeg_detect_process)

    def test_live_capture_thread_kills_ffmpeg_that_ignores_sigterm(self):
        watchdog = self._build_stopping_watchdog(capture_reading=True)
        process = watchdog.ffmpeg_detect_process
        process.wait.side_effect = [sp.TimeoutExpired("ffmpeg", 30), 0]

        watchdog.stop_all_ffmpeg()

        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_args_list, [call(timeout=30), call()])
        process.communicate.assert_not_called()

    def test_joined_capture_thread_uses_stop_ffmpeg(self):
        watchdog = self._build_stopping_watchdog(capture_reading=False)
        process = watchdog.ffmpeg_detect_process
        watchdog.capture_thread.is_alive.side_effect = [True, False]

        with patch("frigate.video.ffmpeg.stop_ffmpeg") as stop_ffmpeg:
            watchdog.stop_all_ffmpeg()

        stop_ffmpeg.assert_called_once_with(process, watchdog.logger)
        process.terminate.assert_not_called()
        self.assertIsNone(watchdog.ffmpeg_detect_process)


class TestCameraWatchdogStreamHealth(unittest.TestCase):
    def _build_watchdog(
        self, sub_enabled: bool = True, output_args: dict | None = None
    ) -> CameraWatchdog:
        return build_watchdog(sub_enabled, output_args)

    def test_stale_sub_does_not_mark_main_stale(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = now.timestamp()
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = now.timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is None
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is not None

    def test_stale_main_does_not_mark_sub_stale(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = stale
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = now.timestamp()
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = now.timestamp()

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is not None
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is None

    def test_grace_period_suppresses_staleness(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        watchdog.record_enable_time = now - timedelta(seconds=10)
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = (
            now - timedelta(hours=1)
        ).timestamp()

        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is None

    def test_status_goes_to_the_matching_role_topic(self):
        watchdog = self._build_watchdog()

        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", 100.0)
        watchdog._send_record_status(STREAM_TYPE_SUB, "offline", 100.0)

        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/record", "online"
        )
        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/record_sub", "offline"
        )

    def test_status_is_cached_per_stream(self):
        watchdog = self._build_watchdog()

        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", 100.0)
        watchdog._send_record_status(STREAM_TYPE_SUB, "online", 100.0)
        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", 100.0)

        assert watchdog.requestor.send_data.call_count == 2

    def test_recorded_streams_follows_config(self):
        watchdog = self._build_watchdog()
        assert watchdog._recorded_streams(["record"]) == [STREAM_TYPE_MAIN]
        assert watchdog._recorded_streams(["detect", "record_sub"]) == [STREAM_TYPE_SUB]
        assert watchdog._recorded_streams(["detect"]) == []

        disabled = self._build_watchdog(sub_enabled=False)
        assert disabled._recorded_streams(["detect", "record_sub"]) == []

    def test_restart_grace_suppresses_repeat_staleness(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = stale
        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is not None

        watchdog._grant_restart_grace([STREAM_TYPE_MAIN], now)

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is None
        assert (
            watchdog._stream_staleness(STREAM_TYPE_MAIN, now + timedelta(seconds=89))
            is None
        )
        assert (
            watchdog._stream_staleness(
                STREAM_TYPE_MAIN,
                now
                + timedelta(
                    seconds=watchdog.record_stale_threshold[STREAM_TYPE_MAIN] + 1
                ),
            )
            is not None
        )

    def test_restart_grace_is_per_stream(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        for stream_type in (STREAM_TYPE_MAIN, STREAM_TYPE_SUB):
            watchdog.latest_cache_segment_time[stream_type] = stale
            watchdog.latest_valid_segment_time[stream_type] = stale

        watchdog._grant_restart_grace([STREAM_TYPE_MAIN], now)

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is None
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is not None

    def test_detect_reset_grants_the_shared_sub_stream_grace(self):
        watchdog = self._build_watchdog()
        watchdog.detect_process_records_sub = True
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.capture_thread.is_alive.return_value = False
        watchdog.start_ffmpeg_detect = MagicMock()

        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is not None

        watchdog.reset_capture_thread(terminate=False)

        # the sub check runs later in the same tick against a stale can_restart,
        # so without this grace it would kill the just-restarted process again
        assert (
            watchdog._stream_staleness(STREAM_TYPE_SUB, datetime.now().astimezone(UTC))
            is None
        )

    def test_shared_sub_goes_offline_with_detect(self):
        """B42 (upstream #24544): the sub stream recorded by the detect
        process reports offline with detect, not once its segments go stale."""
        watchdog = self._build_watchdog()
        watchdog.detect_process_records_sub = True
        watchdog.reset_capture_thread = MagicMock()
        now = datetime.now().astimezone(UTC)
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = now.timestamp()
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = now.timestamp()

        watchdog._send_detect_status("online", 100.0)
        assert watchdog._check_shared_sub_stream(100.0, True) is False
        watchdog._send_detect_status("offline", 101.0)
        assert watchdog._check_shared_sub_stream(101.0, True) is False

        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/record_sub", "online"
        )
        assert watchdog.requestor.send_data.call_args_list[-1].args == (
            "front_door/status/record_sub",
            "offline",
        )
        watchdog.reset_capture_thread.assert_not_called()

    def test_stale_shared_sub_restarts_detect_while_detect_is_online(self):
        watchdog = self._build_watchdog()
        watchdog.detect_process_records_sub = True
        watchdog.reset_capture_thread = MagicMock()
        stale = (datetime.now().astimezone(UTC) - timedelta(hours=1)).timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale
        watchdog._send_detect_status("online", 100.0)

        assert watchdog._check_shared_sub_stream(100.0, False) is False
        watchdog.reset_capture_thread.assert_not_called()

        assert watchdog._check_shared_sub_stream(100.0, True) is True
        watchdog.reset_capture_thread.assert_called_once_with()
        assert watchdog.requestor.send_data.call_args_list[-1].args == (
            "front_door/status/record_sub",
            "offline",
        )

    def test_detect_reset_leaves_sub_alone_when_not_shared(self):
        watchdog = self._build_watchdog()
        watchdog.detect_process_records_sub = False
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.capture_thread.is_alive.return_value = False
        watchdog.start_ffmpeg_detect = MagicMock()

        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale

        watchdog.reset_capture_thread(terminate=False)

        assert (
            watchdog._stream_staleness(STREAM_TYPE_SUB, datetime.now().astimezone(UTC))
            is not None
        )

    def test_stale_threshold_follows_each_stream_segment_time(self):
        watchdog = self._build_watchdog(
            output_args={
                "record": "-f segment -segment_time 10 -c copy",
                "record_sub": "-f segment -segment_time 60 -c copy",
            }
        )

        assert watchdog.record_stale_threshold[STREAM_TYPE_MAIN] == 120
        assert watchdog.record_stale_threshold[STREAM_TYPE_SUB] == 150


class TestRecordStatusRecovery(unittest.TestCase):
    """B32 (upstream #24522): record status returns online after a restart."""

    def test_offline_after_a_restart_is_followed_by_online(self):
        watchdog = build_watchdog()
        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", 100.0)

        _send_roles_offline(watchdog, [CameraRoleEnum.record], 101.0)
        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", 102.0)

        topics = [
            call.args
            for call in watchdog.requestor.send_data.call_args_list
            if call.args[0] == "front_door/status/record"
        ]
        assert topics == [
            ("front_door/status/record", "online"),
            ("front_door/status/record", "offline"),
            ("front_door/status/record", "online"),
        ]

    def test_non_record_roles_are_sent_offline_directly(self):
        watchdog = build_watchdog()

        _send_roles_offline(watchdog, [CameraRoleEnum.audio], 100.0)

        watchdog.requestor.send_data.assert_called_once_with(
            "front_door/status/audio", "offline"
        )

    def test_detect_resend_does_not_starve_the_record_resend(self):
        watchdog = build_watchdog()
        watchdog._send_detect_status("online", 100.0)
        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", 100.0)
        watchdog.requestor.send_data.reset_mock()

        later = 100.0 + watchdog.sleeptime
        watchdog._send_detect_status("online", later)
        watchdog._send_record_status(STREAM_TYPE_MAIN, "online", later)

        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/detect", "online"
        )
        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/record", "online"
        )

    def test_an_exited_recorder_is_not_reported_online(self):
        watchdog = build_watchdog()
        now = datetime.now().astimezone(UTC)
        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = now.timestamp()
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = now.timestamp()
        exited = {"process": MagicMock(**{"poll.return_value": 1})}

        restarted = _check_record_staleness(
            watchdog, exited, [STREAM_TYPE_MAIN], now.timestamp(), now, True
        )

        assert restarted is False
        watchdog.requestor.send_data.assert_not_called()


class TestWatchdogHeartbeat(unittest.TestCase):
    """Fork (SV12): the watchdog reports that its loop is still turning."""

    def test_reports_at_most_every_heartbeat_interval(self):
        watchdog = build_watchdog()
        watchdog.heartbeat = MagicMock(value=0.0)

        with patch("frigate.video.ffmpeg.time.time", return_value=1000.0):
            watchdog._beat()
        with patch("frigate.video.ffmpeg.time.time", return_value=1001.0):
            watchdog._beat()
        self.assertEqual(watchdog.heartbeat.value, 1000.0)

        with patch(
            "frigate.video.ffmpeg.time.time", return_value=1000.0 + HEARTBEAT_SECONDS
        ):
            watchdog._beat()
        self.assertEqual(watchdog.heartbeat.value, 1000.0 + HEARTBEAT_SECONDS)

    def test_without_shared_state_there_is_nothing_to_report(self):
        watchdog = build_watchdog()

        self.assertIsNone(watchdog.heartbeat)
        watchdog._beat()
