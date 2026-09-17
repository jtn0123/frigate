"""Fork (SV6): tests for the camera unreachable notification."""

import importlib.util
import logging
import sys
import unittest
from pathlib import Path

# frigate.video.__init__ pulls in the detection pipeline (zmq, cv2), which the
# outage tracker does not need and a plain interpreter cannot import, so the
# module is loaded straight from its file.
_MODULE_PATH = Path(__file__).resolve().parents[1] / "video/camera_outage.py"
_SPEC = importlib.util.spec_from_file_location("fork_camera_outage", _MODULE_PATH)
_OUTAGE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _OUTAGE
_SPEC.loader.exec_module(_OUTAGE)

CameraOutageTracker = _OUTAGE.CameraOutageTracker
DEFAULT_THRESHOLD_SECONDS = _OUTAGE.DEFAULT_THRESHOLD_SECONDS
MIN_THRESHOLD_SECONDS = _OUTAGE.MIN_THRESHOLD_SECONDS
NO_FRAMES = _OUTAGE.NO_FRAMES
NO_SEGMENTS = _OUTAGE.NO_SEGMENTS
describe_duration = _OUTAGE.describe_duration
outage_message = _OUTAGE.outage_message
outage_threshold = _OUTAGE.outage_threshold
push_enabled = _OUTAGE.push_enabled


class FakeValue:
    """Stand-in for the manager value the camera stats publish."""

    def __init__(self) -> None:
        self.value = 0.0


def make_tracker(**kwargs):
    logger = logging.getLogger("test.outage")
    logger.addHandler(logging.NullHandler())
    sent: list[dict] = []
    tracker = CameraOutageTracker(
        "doorbell",
        logger,
        threshold=600,
        since=kwargs.pop("since", None),
        notify=sent.append,
        **kwargs,
    )
    return tracker, sent


class TestOutageThreshold(unittest.TestCase):
    def test_default_when_unset_or_unparsable(self):
        self.assertEqual(outage_threshold({}), DEFAULT_THRESHOLD_SECONDS)
        self.assertEqual(
            outage_threshold({"FORK_CAMERA_OUTAGE_SECONDS": "soon"}),
            DEFAULT_THRESHOLD_SECONDS,
        )

    def test_reads_the_env_var_but_keeps_a_floor(self):
        self.assertEqual(outage_threshold({"FORK_CAMERA_OUTAGE_SECONDS": "1800"}), 1800)
        self.assertEqual(
            outage_threshold({"FORK_CAMERA_OUTAGE_SECONDS": "5"}),
            MIN_THRESHOLD_SECONDS,
        )

    def test_push_is_off_unless_asked_for(self):
        self.assertFalse(push_enabled({}))
        self.assertFalse(push_enabled({"FORK_CAMERA_OUTAGE_PUSH": "0"}))
        self.assertTrue(push_enabled({"FORK_CAMERA_OUTAGE_PUSH": "true"}))
        self.assertTrue(push_enabled({"FORK_CAMERA_OUTAGE_PUSH": " ON "}))


class TestDurations(unittest.TestCase):
    def test_reads_as_a_sentence(self):
        self.assertEqual(describe_duration(-1), "0 seconds")
        self.assertEqual(describe_duration(45), "45 seconds")
        self.assertEqual(describe_duration(60), "1 minute")
        self.assertEqual(describe_duration(600), "10 minutes")
        self.assertEqual(describe_duration(3600), "1 hour")
        self.assertEqual(describe_duration(7200), "2 hours")
        self.assertEqual(describe_duration(4500), "1h 15m")


class TestCameraOutageTracker(unittest.TestCase):
    def test_no_event_below_the_threshold(self):
        tracker, sent = make_tracker()
        start = 1_000.0

        self.assertIsNone(tracker.update(start, last_frame_time=start))
        self.assertIsNone(tracker.update(start + 599, last_frame_time=start))
        self.assertEqual(tracker.history, [])
        self.assertEqual(sent, [])

    def test_one_event_when_it_crosses_the_threshold(self):
        since = FakeValue()
        tracker, sent = make_tracker(since=since)
        start = 1_000.0
        tracker.update(start, last_frame_time=start)

        event = tracker.update(start + 601, last_frame_time=start)

        self.assertIsNotNone(event)
        self.assertEqual(event["state"], "down")
        self.assertEqual(event["reason"], NO_FRAMES)
        self.assertEqual(event["camera"], "doorbell")
        self.assertEqual(since.value, event["since"])
        self.assertEqual([e["state"] for e in tracker.history], ["down"])
        self.assertEqual(sent, [event])

    def test_no_repeat_while_it_stays_down(self):
        tracker, sent = make_tracker()
        start = 1_000.0
        tracker.update(start, last_frame_time=start)
        tracker.update(start + 601, last_frame_time=start)

        for tick in range(602, 20_000, 37):
            self.assertIsNone(tracker.update(start + tick, last_frame_time=start))

        self.assertEqual(len(tracker.history), 1)
        self.assertEqual(len(sent), 1)

    def test_one_event_when_it_recovers(self):
        since = FakeValue()
        tracker, sent = make_tracker(since=since)
        start = 1_000.0
        tracker.update(start, last_frame_time=start)
        tracker.update(start + 601, last_frame_time=start)

        back = start + 3_000
        event = tracker.update(back, last_frame_time=back)

        self.assertEqual(event["state"], "recovered")
        self.assertEqual(event["duration"], round(back - (start + 1), 1))
        self.assertAlmostEqual(since.value, 0.0)
        self.assertEqual([e["state"] for e in tracker.history], ["down", "recovered"])
        self.assertEqual(len(sent), 2)

        # and it stays quiet afterwards
        self.assertIsNone(tracker.update(back + 5, last_frame_time=back + 5))
        self.assertEqual(len(sent), 2)

    def test_a_second_outage_is_reported_again(self):
        tracker, sent = make_tracker()
        start = 1_000.0
        tracker.update(start, last_frame_time=start)
        tracker.update(start + 601, last_frame_time=start)
        tracker.update(start + 700, last_frame_time=start + 700)
        tracker.update(start + 1_400, last_frame_time=start + 700)

        self.assertEqual(
            [e["state"] for e in tracker.history], ["down", "recovered", "down"]
        )
        self.assertEqual(len(sent), 3)

    def test_disabled_camera_is_ignored(self):
        since = FakeValue()
        tracker, sent = make_tracker(since=since)
        start = 1_000.0
        tracker.update(start, enabled=False, last_frame_time=start)

        self.assertIsNone(
            tracker.update(start + 10_000, enabled=False, last_frame_time=start)
        )
        self.assertEqual(tracker.history, [])
        self.assertEqual(sent, [])
        self.assertAlmostEqual(since.value, 0.0)

    def test_disabling_a_down_camera_drops_the_outage_silently(self):
        since = FakeValue()
        tracker, sent = make_tracker(since=since)
        start = 1_000.0
        tracker.update(start, last_frame_time=start)
        tracker.update(start + 601, last_frame_time=start)

        self.assertIsNone(
            tracker.update(start + 700, enabled=False, last_frame_time=start)
        )
        self.assertEqual(len(sent), 1)
        self.assertIsNone(tracker.down_since)
        self.assertAlmostEqual(since.value, 0.0)

    def test_missing_recording_segments_count_while_recording(self):
        tracker, _sent = make_tracker()
        start = 1_000.0
        tracker.update(start, last_frame_time=start, record_enabled=True)

        # frames keep coming, but no valid segment has been written
        event = tracker.update(
            start + 601, last_frame_time=start + 601, record_enabled=True
        )

        self.assertEqual(event["state"], "down")
        self.assertEqual(event["reason"], NO_SEGMENTS)

    def test_missing_segments_are_ignored_when_recording_is_off(self):
        tracker, _sent = make_tracker()
        start = 1_000.0
        tracker.update(start, last_frame_time=start, record_enabled=False)

        self.assertIsNone(
            tracker.update(
                start + 5_000, last_frame_time=start + 5_000, record_enabled=False
            )
        )

    def test_both_reasons_are_named(self):
        tracker, _sent = make_tracker()
        start = 1_000.0
        tracker.update(start, last_frame_time=start, record_enabled=True)

        event = tracker.update(start + 601, last_frame_time=start, record_enabled=True)

        self.assertEqual(event["reason"], f"{NO_FRAMES} and {NO_SEGMENTS}")

    def test_an_ffmpeg_restart_does_not_fake_an_outage(self):
        """The watchdog's frame time goes back to 0 on every ffmpeg restart."""
        tracker, sent = make_tracker()
        start = 1_000.0

        for tick in range(0, 3_000, 10):
            tracker.update(start + tick, last_frame_time=start + tick)

        self.assertIsNone(tracker.update(start + 3_001, last_frame_time=0.0))
        self.assertEqual(sent, [])

    def test_history_keeps_one_day(self):
        tracker, _sent = make_tracker(history=[{"time": 1.0, "state": "down"}])
        start = 200_000.0
        tracker.update(start, last_frame_time=start)
        tracker.update(start + 601, last_frame_time=start)

        self.assertEqual([e["state"] for e in tracker.history], ["down"])
        self.assertGreater(tracker.history[0]["time"], 1.0)

    def test_a_failing_notifier_does_not_break_the_watchdog(self):
        logger = logging.getLogger("test.outage")
        logger.addHandler(logging.NullHandler())

        def explode(_event):
            raise RuntimeError("no socket")

        tracker = CameraOutageTracker("doorbell", logger, threshold=600, notify=explode)
        start = 1_000.0
        tracker.update(start, last_frame_time=start)

        with self.assertLogs("test.outage", level="ERROR"):
            event = tracker.update(start + 601, last_frame_time=start)

        self.assertEqual(event["state"], "down")


class TestOutageMessage(unittest.TestCase):
    def test_down_and_recovered_read_plainly(self):
        down = {
            "camera": "doorbell",
            "state": "down",
            "reason": NO_FRAMES,
            "time": 1_600.0,
            "since": 1_000.0,
        }
        self.assertEqual(
            outage_message(down),
            "doorbell has been unreachable for over 10 minutes (no frames)",
        )

        recovered = {
            "camera": "doorbell",
            "state": "recovered",
            "time": 5_000.0,
            "since": 1_000.0,
            "duration": 4_000.0,
        }
        self.assertEqual(
            outage_message(recovered),
            "doorbell is delivering again after 1h 6m unreachable",
        )


if __name__ == "__main__":
    unittest.main()
