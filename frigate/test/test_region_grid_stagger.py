"""B43 (upstream #24790): daily region grid rebuilds are staggered per camera."""

import importlib
import queue
import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

# frigate.video re-exports a detect function, so load the module itself
detect = importlib.import_module("frigate.video.detect")

REBUILD_AT = datetime(2026, 10, 25, 2, 0, tzinfo=UTC)


class _FakeDatetime(datetime):
    current = REBUILD_AT

    @classmethod
    def now(cls, tz=None):
        return cls.current


def _run_one_pass(offset_seconds: int, now: datetime) -> MagicMock:
    """Run one pass of process_frames and return the region grid requestor."""
    requestor = MagicMock()
    requestor.send_data.return_value = []
    camera_config = MagicMock()
    camera_config.name = "front"
    camera_config.enabled = True
    stop_event = MagicMock()
    stop_event.is_set.return_value = False
    _FakeDatetime.current = now

    with (
        patch.object(detect, "CameraConfigUpdateSubscriber") as subscriber,
        patch.object(detect, "get_min_region_size", return_value=160),
        patch.object(detect, "get_tomorrow_at_time", return_value=REBUILD_AT),
        patch.object(detect.random, "randrange", return_value=offset_seconds),
        patch.object(detect, "datetime", _FakeDatetime),
    ):
        subscriber.return_value.check_for_updates.return_value = {}
        detect.process_frames(
            requestor,
            queue.Queue(),
            (720, 1280),
            MagicMock(),
            camera_config,
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            stop_event,
            MagicMock(),
            [],
            exit_on_empty=True,
        )

    return requestor


class TestRegionGridStagger(unittest.TestCase):
    def test_rebuild_waits_for_the_camera_offset(self):
        requestor = _run_one_pass(1800, REBUILD_AT + timedelta(minutes=15))
        requestor.send_data.assert_not_called()

    def test_rebuild_runs_once_the_offset_has_passed(self):
        requestor = _run_one_pass(1800, REBUILD_AT + timedelta(minutes=31))
        requestor.send_data.assert_called_once()

    def test_offset_is_drawn_from_the_first_hour(self):
        with patch.object(detect.random, "randrange", return_value=0) as draw:
            with (
                patch.object(detect, "CameraConfigUpdateSubscriber"),
                patch.object(detect, "get_min_region_size", return_value=160),
            ):
                stop_event = MagicMock()
                stop_event.is_set.return_value = True
                detect.process_frames(
                    MagicMock(),
                    queue.Queue(),
                    (720, 1280),
                    MagicMock(),
                    MagicMock(),
                    MagicMock(),
                    MagicMock(),
                    MagicMock(),
                    MagicMock(),
                    MagicMock(),
                    MagicMock(),
                    stop_event,
                    MagicMock(),
                    [],
                )
        draw.assert_called_once_with(3600)


if __name__ == "__main__":
    unittest.main()
