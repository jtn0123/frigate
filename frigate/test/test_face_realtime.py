"""Tests for the real time face processor using the shared face detector."""

import base64
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from frigate.comms.embeddings_updater import EmbeddingsRequestEnum
from frigate.data_processing.common.face.detector import DetectionResult
from frigate.data_processing.real_time import face as face_module
from frigate.data_processing.real_time.face import FaceRealTimeProcessor

CAMERA = "front"
LANDMARKS = ((1.0, 1.0),) * 5


def _config(all_objects, model_size="small", save_attempts=0):
    return SimpleNamespace(
        objects=SimpleNamespace(all_objects=all_objects),
        face_recognition=SimpleNamespace(
            model_size=model_size,
            detection_threshold=0.7,
            unknown_score=0.8,
            recognition_threshold=0.9,
            min_faces=1,
            save_attempts=save_attempts,
        ),
        cameras={
            CAMERA: SimpleNamespace(
                face_recognition=SimpleNamespace(enabled=True, min_area=500)
            )
        },
    )


def _metrics():
    return SimpleNamespace(
        face_rec_fps=SimpleNamespace(value=0.0),
        face_rec_speed=SimpleNamespace(value=0.0),
    )


def _encoded(image: np.ndarray) -> str:
    _, buffer = cv2.imencode(".png", image)
    return base64.b64encode(buffer.tobytes()).decode()


class _ProcessorTestCase(unittest.TestCase):
    all_objects = ["person"]

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.face_dir = tmp.name

        self.patches = {}
        for target, value in (
            ("FACE_DIR", self.face_dir),
            ("FaceDetector", MagicMock()),
            ("FaceNetRecognizer", MagicMock()),
            ("ArcFaceRecognizer", MagicMock()),
        ):
            patcher = patch.object(face_module, target, value)
            self.patches[target] = patcher.start()
            self.addCleanup(patcher.stop)

    def _processor(self, **config_kwargs) -> FaceRealTimeProcessor:
        processor = FaceRealTimeProcessor(
            _config(self.all_objects, **config_kwargs),
            MagicMock(),
            MagicMock(),
            _metrics(),
        )
        self.detector = processor.face_detector
        self.recognizer = processor.recognizer
        return processor


class TestProcessorSetup(_ProcessorTestCase):
    def test_small_model_uses_facenet_with_the_shared_detector(self):
        processor = self._processor(model_size="small")

        detector_class = self.patches["FaceDetector"]
        detector_class.assert_called_once_with(
            on_ready=processor.faces_per_second.start
        )
        self.patches["FaceNetRecognizer"].assert_called_once_with(
            processor.config, detector_class.return_value
        )
        self.patches["ArcFaceRecognizer"].assert_not_called()
        processor.recognizer.build.assert_called_once_with()

    def test_large_model_uses_arcface_with_the_shared_detector(self):
        processor = self._processor(model_size="large")

        self.patches["ArcFaceRecognizer"].assert_called_once_with(
            processor.config, self.patches["FaceDetector"].return_value
        )
        self.patches["FaceNetRecognizer"].assert_not_called()


class TestManualFaceDetection(_ProcessorTestCase):
    """Without a face model in the detector, faces are found in the person crop."""

    def _run(self, processor, box=(10, 20, 90, 100)):
        # a 100x120 I420 frame, the person fills most of it
        frame = np.zeros((180, 100), np.uint8)
        processor.process_frame(
            {"camera": CAMERA, "id": "1.0-abc", "label": "person", "box": box},
            frame,
        )

    def test_detected_face_is_cropped_from_the_person_and_classified(self):
        processor = self._processor()
        self.detector.detect.return_value = DetectionResult(
            face=(5, 10, 35, 50), landmarks=LANDMARKS
        )
        self.recognizer.classify.return_value = ("alice", 0.95)

        self._run(processor)

        person = self.detector.detect.call_args.args[0]
        self.assertEqual(person.shape, (80, 80, 3))
        self.assertEqual(self.detector.detect.call_args.args[1], 0.7)
        self.assertEqual(self.recognizer.classify.call_args.args[0].shape, (40, 30, 3))
        processor.sub_label_publisher.publish.assert_called_once()
        self.assertEqual(
            processor.sub_label_publisher.publish.call_args.args[0],
            ("1.0-abc", "alice", 0.95),
        )

    def test_no_detected_face_skips_recognition(self):
        processor = self._processor()
        self.detector.detect.return_value = None

        self._run(processor)

        self.recognizer.classify.assert_not_called()

    def test_face_smaller_than_min_area_is_skipped(self):
        processor = self._processor()
        self.detector.detect.return_value = DetectionResult(
            face=(0, 0, 10, 10), landmarks=LANDMARKS
        )

        self._run(processor)

        self.recognizer.classify.assert_not_called()


class TestFaceAttributes(_ProcessorTestCase):
    """With a face model, the best face attribute box is used directly."""

    all_objects = ["person", "face"]

    def _run(self, processor, attributes):
        frame = np.zeros((180, 100), np.uint8)
        processor.process_frame(
            {
                "camera": CAMERA,
                "id": "1.0-abc",
                "label": "person",
                "current_attributes": attributes,
            },
            frame,
        )

    def test_highest_scoring_face_box_is_classified(self):
        processor = self._processor()
        self.recognizer.classify.return_value = ("alice", 0.95)

        self._run(
            processor,
            [
                {"label": "face", "score": 0.6, "box": (0, 0, 30, 30)},
                {"label": "face", "score": 0.9, "box": (10, 10, 50, 40)},
            ],
        )

        self.assertEqual(self.recognizer.classify.call_args.args[0].shape, (30, 40, 3))
        self.detector.detect.assert_not_called()

    def test_face_box_below_min_area_is_skipped(self):
        processor = self._processor()

        self._run(processor, [{"label": "face", "score": 0.9, "box": (0, 0, 5, 5)}])

        self.recognizer.classify.assert_not_called()


class TestFaceRequests(_ProcessorTestCase):
    def setUp(self):
        super().setUp()
        self.image = np.zeros((100, 80, 3), np.uint8)
        self.image[20:60, 10:40] = 200

    def test_recognize_classifies_the_detected_face(self):
        processor = self._processor()
        self.detector.detect.return_value = DetectionResult(
            face=(10, 20, 40, 60), landmarks=LANDMARKS
        )
        self.recognizer.classify.return_value = ("alice", 0.95)

        result = processor.handle_request(
            EmbeddingsRequestEnum.recognize_face.value,
            {"image": _encoded(self.image)},
        )

        self.assertEqual(result, {"success": True, "score": 0.95, "face_name": "alice"})
        face = self.recognizer.classify.call_args.args[0]
        self.assertEqual(face.shape, (40, 30, 3))
        self.assertTrue(np.all(face == 200))

    def test_recognize_reports_when_no_face_is_found(self):
        processor = self._processor()
        self.detector.detect.return_value = None

        result = processor.handle_request(
            EmbeddingsRequestEnum.recognize_face.value,
            {"image": _encoded(self.image)},
        )

        self.assertEqual(result["success"], False)
        self.recognizer.classify.assert_not_called()

    def test_register_saves_the_detected_face_to_the_library(self):
        processor = self._processor()
        self.detector.detect.return_value = DetectionResult(
            face=(10, 20, 40, 60), landmarks=LANDMARKS
        )

        result = processor.handle_request(
            EmbeddingsRequestEnum.register_face.value,
            {"face_name": "alice", "image": _encoded(self.image)},
        )

        self.assertTrue(result["success"])
        files = os.listdir(os.path.join(self.face_dir, "alice"))
        self.assertEqual(len(files), 1)
        saved = cv2.imread(os.path.join(self.face_dir, "alice", files[0]))
        self.assertEqual(saved.shape, (40, 30, 3))
        self.recognizer.clear.assert_called_once_with()

    def test_register_reports_when_no_face_is_found(self):
        processor = self._processor()
        self.detector.detect.return_value = None

        result = processor.handle_request(
            EmbeddingsRequestEnum.register_face.value,
            {"face_name": "alice", "image": _encoded(self.image)},
        )

        self.assertEqual(result["success"], False)
        self.assertFalse(os.path.exists(os.path.join(self.face_dir, "alice")))


class TestFaceAttemptTrimming(_ProcessorTestCase):
    def test_saved_attempts_are_capped(self):
        processor = self._processor(save_attempts=2)
        face = np.zeros((10, 10, 3), np.uint8)

        for i in range(4):
            processor.write_face_attempt(face, f"1.0-{i}", 1000.0 + i, "a-b", 0.9)

        files = sorted(os.listdir(os.path.join(self.face_dir, "train")))
        self.assertEqual(len(files), 2)
        # the newest attempts are kept, with dashes in names replaced
        self.assertEqual(files[-1], "1.0-3-1003.0-a_b-0.9.webp")


if __name__ == "__main__":
    unittest.main()
