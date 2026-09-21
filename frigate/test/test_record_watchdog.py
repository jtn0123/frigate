"""Fork (SV3): the record stale check must not restart ffmpeg every second."""

import logging
import unittest
from collections import deque
from datetime import UTC, datetime, timedelta
from enum import Enum
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frigate.video.ffmpeg import CameraWatchdog
from frigate.video.restart_log import RestartLog

START = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)


class Role(str, Enum):
    record = "record"


class FakeDatetime(datetime):
    """A `datetime` whose `now()` follows a clock the test moves by hand."""

    current = START

    @classmethod
    def now(cls, tz=None):
        return cls.current if tz is None else cls.current.astimezone(tz)


class FakeStopEvent:
    """Runs the watchdog loop once per step, moving the clock by that step."""

    def __init__(self, steps):
        self.steps = list(steps)

    def wait(self, _timeout):
        if not self.steps:
            return True
        FakeDatetime.current += timedelta(seconds=self.steps.pop(0))
        return False


def watchdog(steps, stale_age=1000):
    """A watchdog whose record segments are already stale when the loop starts."""
    logger = logging.getLogger("watchdog.back")
    stale_time = (START - timedelta(seconds=stale_age)).timestamp()
    dog = SimpleNamespace(
        logger=logger,
        config=SimpleNamespace(
            name="back",
            enabled=True,
            detect=SimpleNamespace(fps=5),
            record=SimpleNamespace(enabled=True, enabled_in_config=True),
        ),
        sleeptime=10,
        stop_event=FakeStopEvent(steps),
        _update_enabled_state=MagicMock(return_value=True),
        _check_config_updates=MagicMock(return_value={}),
        start_all_ffmpeg=MagicMock(),
        stop_all_ffmpeg=MagicMock(),
        _send_detect_status=MagicMock(),
        _send_record_status=MagicMock(),
        _check_hwaccel_fallback=MagicMock(),
        _check_outage=MagicMock(),  # fork (SV6)
        _hwaccel_fallback_expired=MagicMock(return_value=False),  # fork (B5)
        reset_capture_thread=MagicMock(),
        was_enabled=True,
        was_record_enabled_in_config=True,
        hwaccel_fallback=MagicMock(),
        _publish_hwaccel_fallback=MagicMock(),
        logpipe=MagicMock(),
        config_subscriber=MagicMock(),
        segment_subscriber=MagicMock(**{"check_for_update.return_value": (None, None)}),
        requestor=MagicMock(),
        capture_thread=MagicMock(
            **{
                "is_alive.return_value": True,
                "current_frame": SimpleNamespace(value=START.timestamp()),
            }
        ),
        camera_fps=SimpleNamespace(value=5),
        fps_overflow_count=0,
        _crash_logged=None,
        ffmpeg_other_processes=[
            {
                "cmd": ["ffmpeg"],
                "roles": [Role.record],
                "logpipe": MagicMock(),
                "process": MagicMock(**{"poll.return_value": None}),
            }
        ],
        restart_log=RestartLog("back", logger, []),
        record_stale_threshold=150,
        record_enable_time=None,
        record_restart_time=None,
        latest_valid_segment_time=stale_time,
        latest_invalid_segment_time=0,
        latest_cache_segment_time=stale_time,
        reconnect_timestamps=deque(),
        reconnects=None,
        detection_frame=None,
        stalls=None,
        _stall_timestamps=deque(),
        _stall_active=False,
    )

    for name in (
        "_drain_segment_updates",
        "_check_detect_process",
        "_check_record_processes",
        "_record_in_grace",
        "_record_stall_reason",
        "_restart_stalled_record",
    ):
        setattr(dog, name, getattr(CameraWatchdog, name).__get__(dog))
    return dog


class TestRecordRestartThrash(unittest.TestCase):
    def setUp(self):
        FakeDatetime.current = START
        patcher = patch("frigate.video.ffmpeg.datetime", FakeDatetime)
        patcher.start()
        self.addCleanup(patcher.stop)
        sleep_patcher = patch("frigate.video.ffmpeg.time.sleep")
        sleep_patcher.start()
        self.addCleanup(sleep_patcher.stop)
        starter = patch("frigate.video.ffmpeg.start_or_restart_ffmpeg")
        self.start_ffmpeg = starter.start()
        # A restarted process is running, so the watchdog's exit branch
        # (poll() is not None) stays out of the way.
        self.start_ffmpeg.return_value = MagicMock(**{"poll.return_value": None})
        self.addCleanup(starter.stop)

    def test_a_single_stall_restarts_the_record_process_once(self):
        # The first tick clears the 90 s grace that follows enabling record.
        dog = watchdog([95, 1, 1, 1, 1])

        CameraWatchdog.run(dog)

        self.assertEqual(self.start_ffmpeg.call_count, 1)
        self.assertEqual(len(dog.restart_log.history), 1)

    def test_a_stall_that_outlives_the_grace_restarts_again(self):
        # The stall outlives the 150 s the restarted process is given.
        dog = watchdog([95, 100, 100, 100])

        CameraWatchdog.run(dog)

        self.assertEqual(self.start_ffmpeg.call_count, 2)

    def test_healthy_segments_never_restart_the_record_process(self):
        dog = watchdog([95, 1, 1, 1, 1], stale_age=0)

        CameraWatchdog.run(dog)

        self.start_ffmpeg.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
