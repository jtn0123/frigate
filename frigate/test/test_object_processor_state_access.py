"""TrackedObjectProcessor reads camera states through its lock (D54).

Camera states are added and popped on the processor thread while API and
dispatcher threads read them, so every reader resolves the state once and
treats a missing camera as empty."""

import base64
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

import cv2
import numpy as np

from frigate.track.object_processing import TrackedObjectProcessor


def _processor(**states) -> TrackedObjectProcessor:
    processor = TrackedObjectProcessor.__new__(TrackedObjectProcessor)
    processor.camera_states = dict(states)
    processor.camera_states_lock = threading.Lock()
    processor.config = SimpleNamespace(
        cameras={}, birdseye=SimpleNamespace(width=1280, height=720)
    )
    processor.event_sender = MagicMock()
    processor.detection_publisher = MagicMock()
    processor.ongoing_manual_events = {}
    processor.frame_manager = MagicMock()
    return processor


def _state(record_enabled=True, pre_capture=5):
    state = MagicMock()
    state.best_objects = {}
    state.frame_cache = {}
    state.current_frame_time = 42.5
    state.camera_config = SimpleNamespace(
        record=SimpleNamespace(enabled=record_enabled, event_pre_capture=pre_capture)
    )
    return state


class TestGetBest(unittest.TestCase):
    def test_unknown_camera_or_label_is_empty(self):
        processor = _processor(front=_state())

        self.assertEqual(processor.get_best("gone", "person"), {})
        self.assertEqual(processor.get_best("front", "person"), {})

    def test_best_object_without_thumbnail_is_empty(self):
        state = _state()
        state.best_objects["person"] = SimpleNamespace(thumbnail_data=None)

        self.assertEqual(_processor(front=state).get_best("front", "person"), {})

    def test_best_object_includes_its_cached_frame(self):
        state = _state()
        frame = np.zeros((2, 2), np.uint8)
        state.frame_cache[10.0] = frame
        thumbnail = {"frame_time": 10.0, "box": (0, 0, 1, 1)}
        state.best_objects["person"] = SimpleNamespace(thumbnail_data=thumbnail)

        best = _processor(front=state).get_best("front", "person")

        self.assertIs(best["frame"], frame)
        self.assertEqual(best["box"], (0, 0, 1, 1))
        # the stored thumbnail is not modified
        self.assertNotIn("frame", thumbnail)


class TestCurrentFrame(unittest.TestCase):
    def test_camera_frame_uses_the_state(self):
        state = _state()
        state.get_current_frame.return_value = "frame"
        processor = _processor(front=state)

        self.assertEqual(processor.get_current_frame("front", {"boxes": True}), "frame")
        state.get_current_frame.assert_called_once_with({"boxes": True})
        self.assertIsNone(processor.get_current_frame("gone"))

    def test_birdseye_frame_comes_from_shared_memory(self):
        processor = _processor()
        processor.frame_manager.get.return_value = "birdseye frame"

        self.assertEqual(processor.get_current_frame("birdseye"), "birdseye frame")
        processor.frame_manager.get.assert_called_once_with(
            "birdseye", (720 * 3 // 2, 1280)
        )

    def test_frame_time(self):
        processor = _processor(front=_state())

        self.assertEqual(processor.get_current_frame_time("front"), 42.5)
        self.assertEqual(processor.get_current_frame_time("gone"), 0.0)


class TestManualEvents(unittest.TestCase):
    def test_lpr_snapshot_is_saved_for_a_known_camera(self):
        state = _state()
        _, png = cv2.imencode(".png", np.full((4, 6, 3), 255, np.uint8))
        payload = (base64.b64encode(png.tobytes()), "evt1", "front")

        _processor(front=state).save_lpr_snapshot(payload)

        img, event_id, label, draw = state.save_manual_event_image.call_args.args
        self.assertEqual(img.shape, (4, 6, 3))
        self.assertEqual((event_id, label, draw), ("evt1", "license_plate", {}))

    def test_manual_event_uses_the_camera_pre_capture(self):
        state = _state(record_enabled=True, pre_capture=5)
        processor = _processor(front=state)

        processor.create_manual_event(
            (100.0, "front", "doorbell", "evt1", True, 1.0, None, 30, "api", {}, None)
        )

        event = processor.event_sender.publish.call_args.args[0][4]
        self.assertEqual(event["start_time"], 95.0)
        self.assertEqual(event["end_time"], 130.0)
        self.assertTrue(event["has_clip"])
        state.save_manual_event_image.assert_called_once_with(
            None, "evt1", "doorbell", {}
        )
        self.assertEqual(processor.ongoing_manual_events, {"evt1": "front"})

    def test_manual_event_without_recording_has_no_clip(self):
        state = _state(record_enabled=False)
        processor = _processor(front=state)

        processor.create_manual_event(
            (100.0, "front", "doorbell", "evt1", True, 1.0, None, None, "ui", {}, 2)
        )

        event = processor.event_sender.publish.call_args.args[0][4]
        self.assertEqual(event["start_time"], 98.0)
        self.assertIsNone(event["end_time"])
        self.assertFalse(event["has_clip"])

    def test_manual_event_for_unknown_camera_is_discarded(self):
        processor = _processor()

        processor.create_manual_event(
            (100.0, "gone", "doorbell", "evt1", True, 1.0, None, 30, "api", {}, None)
        )

        processor.event_sender.publish.assert_not_called()


if __name__ == "__main__":
    unittest.main()
