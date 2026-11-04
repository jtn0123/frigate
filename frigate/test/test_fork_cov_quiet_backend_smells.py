"""Coverage for the quiet upstream backend files touched by I161.

Drives the centroid tracker, the legacy motion detector, the ground plane
speed helper, the bird classifier and the PaddleOCR detection input step
through the lines whose local names I161 changed. The bird interpreter and
event publisher are mocked.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np

from frigate.config import DetectConfig
from frigate.config.config import RuntimeMotionConfig
from frigate.data_processing.real_time.bird import BirdRealTimeProcessor
from frigate.embeddings.onnx.lpr_embedding import PaddleOCRDetection
from frigate.motion.frigate_motion import FrigateMotionDetector
from frigate.track.centroid_tracker import CentroidTracker
from frigate.util.velocity import create_ground_plane


def _detection(box: tuple[int, int, int, int]) -> tuple:
    area = (box[2] - box[0]) * (box[3] - box[1])
    return ("person", 0.9, box, area, 1.0, (0, 0, 640, 360))


class TestCentroidTracker(unittest.TestCase):
    def setUp(self) -> None:
        self.tracker = CentroidTracker(
            DetectConfig(width=640, height=360, max_disappeared=1)
        )

    def test_register_assigns_id_and_position(self) -> None:
        self.tracker.match_and_update("f", 1.0, [_detection((10, 10, 50, 50))])

        [(obj_id, obj)] = self.tracker.tracked_objects.items()
        self.assertTrue(obj_id.startswith("1.0-"))
        self.assertEqual(obj["id"], obj_id)
        self.assertEqual(obj["centroid"], (30, 30))
        self.assertEqual(self.tracker.disappeared[obj_id], 0)
        self.assertEqual(self.tracker.positions[obj_id]["xmax"], 640)

    def test_matches_registers_and_expires_by_distance(self) -> None:
        self.tracker.match_and_update("f", 1.0, [_detection((10, 10, 50, 50))])
        [first_id] = self.tracker.tracked_objects

        # the closer box updates the tracked object, the far one is new
        self.tracker.match_and_update(
            "f",
            2.0,
            [_detection((12, 12, 52, 52)), _detection((400, 200, 450, 260))],
        )
        self.assertEqual(len(self.tracker.tracked_objects), 2)
        self.assertEqual(self.tracker.tracked_objects[first_id]["frame_time"], 2.0)
        [second_id] = set(self.tracker.tracked_objects) - {first_id}

        # only the first object is seen, so the second one disappears once
        self.tracker.match_and_update("f", 3.0, [_detection((12, 12, 52, 52))])
        self.assertEqual(self.tracker.disappeared[second_id], 1)
        self.assertEqual(self.tracker.disappeared[first_id], 0)

        # and is deregistered once it reaches max_disappeared
        self.tracker.match_and_update("f", 4.0, [_detection((12, 12, 52, 52))])
        self.assertNotIn(second_id, self.tracker.tracked_objects)
        self.assertIn(first_id, self.tracker.tracked_objects)


class _MotionDetector(FrigateMotionDetector):
    """FrigateMotionDetector leaves stop and update_mask abstract."""

    def stop(self) -> None:
        pass

    def update_mask(self) -> None:
        pass


class TestFrigateMotionDetector(unittest.TestCase):
    def test_reports_motion_after_baseline(self) -> None:
        frame_shape = (100, 100)
        config = RuntimeMotionConfig(frame_shape=frame_shape)
        detector = _MotionDetector(
            frame_shape,
            config,
            fps=5,
            improve_contrast=SimpleNamespace(value=False),
            threshold=SimpleNamespace(value=30),
            contour_area=SimpleNamespace(value=10),
        )

        blank = np.zeros(frame_shape, dtype=np.uint8)
        for _ in range(30):
            self.assertEqual(detector.detect(blank), [])

        moved = blank.copy()
        moved[20:60, 20:60] = 255
        boxes = detector.detect(moved)

        self.assertEqual(len(boxes), 1)
        x1, y1, x2, y2 = boxes[0]
        self.assertTrue(x1 <= 20 and y1 <= 20 and x2 >= 59 and y2 >= 59)


class TestCreateGroundPlane(unittest.TestCase):
    def test_interpolates_side_scales(self) -> None:
        points = [[0, 0], [10, 0], [10, 10], [0, 10]]
        distance_per_pixel = create_ground_plane(points, ["20", "10", "10", "10"])

        # top left: AB scale 2 and DA scale 1
        self.assertAlmostEqual(distance_per_pixel(0, 0), 1.5)
        # bottom right: CD scale 1 and BC scale 1
        self.assertAlmostEqual(distance_per_pixel(10, 10), 1.0)


class TestBirdProcessFrame(unittest.TestCase):
    def _processor(self, output: np.ndarray) -> BirdRealTimeProcessor:
        processor = object.__new__(BirdRealTimeProcessor)
        processor.interpreter = MagicMock()
        processor.interpreter.get_tensor.return_value = output
        processor.tensor_input_details = [{"index": 0}]
        processor.tensor_output_details = [{"index": 1}]
        processor.sub_label_publisher = MagicMock()
        processor.detected_birds = {}
        processor.labelmap = {0: "none", 1: "robin", 2: "sparrow"}
        processor.config = SimpleNamespace(
            classification=SimpleNamespace(bird=SimpleNamespace(threshold=0.5))
        )
        return processor

    def test_classifies_resized_crop(self) -> None:
        processor = self._processor(np.array([[0.0, 255.0, 0.0]]))
        frame = np.zeros((360 * 3 // 2, 640), dtype=np.uint8)
        obj = {"id": "bird-1", "label": "bird", "box": (100, 100, 220, 200)}

        processor.process_frame(obj, frame)

        index, tensor = processor.interpreter.set_tensor.call_args.args
        self.assertEqual(index, 0)
        self.assertEqual(tensor.shape, (1, 224, 224, 3))
        processor.sub_label_publisher.publish.assert_called_once()
        published = processor.sub_label_publisher.publish.call_args.args[0]
        self.assertEqual(published, ("bird-1", "robin", 1.0))
        self.assertEqual(processor.detected_birds, {"bird-1": 1.0})


class TestPaddleOCRDetectionInputs(unittest.TestCase):
    def test_uses_first_input(self) -> None:
        first = np.zeros((1, 3, 4, 4), dtype=np.float32)
        second = np.ones((1, 3, 4, 4), dtype=np.float32)
        detection = object.__new__(PaddleOCRDetection)

        [inputs] = detection._preprocess_inputs([first, second])

        self.assertIs(inputs["x"], first)


if __name__ == "__main__":
    unittest.main()
