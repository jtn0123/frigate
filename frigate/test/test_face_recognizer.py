"""Tests for building face class means and classifying faces against them."""

import os
import queue
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from frigate.data_processing.common.face import recognizer as recognizer_module
from frigate.data_processing.common.face.detector import (
    FACE_TEMPLATE,
    FACE_TEMPLATE_SIZE,
)
from frigate.data_processing.common.face.recognizer import (
    ArcFaceRecognizer,
    FaceNetRecognizer,
    build_class_mean,
    similarity_to_confidence,
)

RED = (0, 0, 255)
BLUE = (255, 0, 0)
GRAY = (128, 128, 128)


def _face(color, size: int = FACE_TEMPLATE_SIZE) -> np.ndarray:
    return np.full((size, size, 3), color, dtype=np.uint8)


def _landmarks_for(image: np.ndarray):
    """Stub landmark model: template shaped for color images, none for gray."""
    if np.all(image[..., 0] == image[..., 1]) and np.all(
        image[..., 1] == image[..., 2]
    ):
        return None

    scale = image.shape[1] / FACE_TEMPLATE_SIZE
    return tuple(map(tuple, FACE_TEMPLATE * scale))


def _embed(images):
    """Stub embedder whose embedding is the mean BGR color of the face."""
    return [
        np.array([img.reshape(-1, 3).mean(axis=0)], dtype=np.float32) for img in images
    ]


class _SyncThread:
    """Runs the build task inline so tests do not race a background thread."""

    def __init__(self, target, daemon=None):
        self.target = target

    def start(self):
        self.target()


def _config(blur_filter: bool = True):
    return SimpleNamespace(
        face_recognition=SimpleNamespace(blur_confidence_filter=blur_filter)
    )


class _RecognizerTests:
    """Shared behavior for both recognizer implementations."""

    recognizer_class: type
    embedder_name: str

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.face_dir = self.tmp.name

        for target, value in (
            ("FACE_DIR", self.face_dir),
            ("threading.Thread", _SyncThread),
            (self.embedder_name, MagicMock(return_value=MagicMock(side_effect=_embed))),
        ):
            patcher = patch(f"{recognizer_module.__name__}.{target}", value)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.detector = MagicMock()
        self.detector.is_ready = True
        self.detector.get_face_landmarks.side_effect = _landmarks_for

    def _recognizer(self, blur_filter: bool = True):
        return self.recognizer_class(_config(blur_filter), self.detector)

    def _add_image(self, person: str, name: str, image: np.ndarray | None = None):
        folder = os.path.join(self.face_dir, person)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)

        if image is None:
            with open(path, "wb") as f:
                f.write(b"not an image")
        else:
            cv2.imwrite(path, image)

    def _build_library(self):
        self._add_image("alice", "a1.png", _face(RED))
        self._add_image("alice", "a2.png", _face(RED))
        self._add_image("bob", "b1.png", _face(BLUE))
        # unreadable and unalignable images are skipped, not fatal
        self._add_image("bob", "broken.png")
        self._add_image("bob", "gray.png", _face(GRAY))
        # a person whose only image cannot be aligned gets no class mean
        self._add_image("carol", "c1.png", _face(GRAY))
        # the train folder holds recognition attempts, not the library
        self._add_image("train", "t1.png", _face(RED))

        with open(os.path.join(self.face_dir, "stray.txt"), "w") as f:
            f.write("not a folder")

    def test_build_waits_for_the_detector(self):
        self.detector.is_ready = False
        recognizer = self._recognizer()

        recognizer.build()

        self.assertIsNone(recognizer.model_builder_queue)
        self.assertEqual(recognizer.mean_embs, {})

    def test_build_starts_the_task_then_collects_its_result(self):
        self._build_library()
        recognizer = self._recognizer()

        recognizer.build()

        # the first call only starts the build
        self.assertEqual(recognizer.mean_embs, {})
        self.assertIsNotNone(recognizer.model_builder_queue)

        recognizer.build()

        self.assertIsNone(recognizer.model_builder_queue)
        self.assertEqual(set(recognizer.mean_embs), {"alice", "bob"})
        np.testing.assert_allclose(recognizer.mean_embs["alice"], RED, atol=1)
        np.testing.assert_allclose(recognizer.mean_embs["bob"], BLUE, atol=1)

    def test_build_keeps_waiting_while_the_task_runs(self):
        recognizer = self._recognizer()
        recognizer.model_builder_queue = queue.Queue()

        with patch.object(
            recognizer.model_builder_queue, "get", side_effect=queue.Empty
        ):
            recognizer.build()

        self.assertIsNotNone(recognizer.model_builder_queue)
        self.assertEqual(recognizer.mean_embs, {})

    def test_empty_library_builds_nothing(self):
        recognizer = self._recognizer()

        recognizer.build()
        recognizer.build()

        self.assertEqual(recognizer.mean_embs, {})

    def test_classify_matches_the_closest_person(self):
        self._build_library()
        recognizer = self._recognizer(blur_filter=False)
        recognizer.build()

        label, score = recognizer.classify(_face(BLUE))

        self.assertEqual(label, "bob")
        self.assertEqual(score, 1.0)

    def test_classify_reduces_confidence_for_a_blurry_face(self):
        self._build_library()
        recognizer = self._recognizer(blur_filter=True)
        recognizer.build()

        # a flat color has no edges at all, the blurriest possible input
        label, score = recognizer.classify(_face(RED))

        self.assertEqual(label, "alice")
        self.assertEqual(score, 0.94)

    def test_classify_returns_none_when_the_face_cannot_be_aligned(self):
        self._build_library()
        recognizer = self._recognizer()
        recognizer.build()

        self.assertIsNone(recognizer.classify(_face(GRAY)))

    def test_classify_returns_none_before_the_detector_is_ready(self):
        self.detector.is_ready = False

        self.assertIsNone(self._recognizer().classify(_face(RED)))

    def test_classify_returns_none_while_the_model_is_built(self):
        self._build_library()
        recognizer = self._recognizer()

        # the first classify only kicks off the build
        self.assertIsNone(recognizer.classify(_face(RED)))
        self.assertEqual(recognizer.classify(_face(RED))[0], "alice")

    def test_clear_drops_the_built_model(self):
        self._build_library()
        recognizer = self._recognizer()
        recognizer.build()
        recognizer.build()

        recognizer.clear()

        self.assertEqual(recognizer.mean_embs, {})


class TestFaceNetRecognizer(_RecognizerTests, unittest.TestCase):
    recognizer_class = FaceNetRecognizer
    embedder_name = "FaceNetEmbedding"


class TestArcFaceRecognizer(_RecognizerTests, unittest.TestCase):
    recognizer_class = ArcFaceRecognizer
    embedder_name = "ArcfaceEmbedding"


class TestBlurConfidenceReduction(unittest.TestCase):
    def _reduction(self, variance: float, enabled: bool = True) -> float:
        with patch.object(recognizer_module, "FaceNetEmbedding"):
            recognizer = FaceNetRecognizer(_config(enabled), MagicMock())

        laplacian = MagicMock()
        laplacian.var.return_value = variance

        with patch.object(recognizer_module.cv2, "Laplacian", return_value=laplacian):
            return recognizer.get_blur_confidence_reduction(_face(RED))

    def test_sharper_images_lose_less_confidence(self):
        self.assertEqual(
            [self._reduction(v) for v in (50, 140, 180, 220, 300)],
            [0.06, 0.04, 0.02, 0.01, 0.0],
        )

    def test_disabled_filter_never_reduces_confidence(self):
        self.assertEqual(self._reduction(0, enabled=False), 0.0)


class TestAlignFaceDegenerate(unittest.TestCase):
    def test_landmarks_collapsed_to_one_point_cannot_be_aligned(self):
        detector = MagicMock()
        detector.get_face_landmarks.return_value = ((10.0, 10.0),) * 5

        with patch.object(recognizer_module, "FaceNetEmbedding"):
            recognizer = FaceNetRecognizer(_config(), detector)

        self.assertIsNone(recognizer.align_face(_face(RED), 112))


class TestBuildClassMean(unittest.TestCase):
    def test_small_collections_skip_outlier_rejection(self):
        embs = [np.array([1.0, 0.0]), np.array([0.0, 1.0])]

        np.testing.assert_allclose(build_class_mean(embs), [0.5, 0.5])

    def test_mislabeled_embeddings_are_dropped(self):
        embs = [np.array([1.0, 0.0, 0.0])] * 5 + [np.array([0.0, 1.0, 0.0])] * 2

        np.testing.assert_allclose(build_class_mean(embs), [1.0, 0.0, 0.0])

    def test_rejection_never_drops_below_the_minimum_kept(self):
        """A strict threshold rejects everything, the closest are kept instead."""
        embs = [np.array([1.0, 0.0, 0.0])] * 5 + [np.array([0.0, 1.0, 0.0])] * 2

        mean = build_class_mean(embs, outlier_threshold=0.99)

        np.testing.assert_allclose(mean, [1.0, 0.0, 0.0])


class TestSimilarityToConfidence(unittest.TestCase):
    def test_median_similarity_maps_to_even_confidence(self):
        self.assertAlmostEqual(similarity_to_confidence(0.3), 0.5)

    def test_confidence_rises_with_similarity(self):
        self.assertLess(similarity_to_confidence(0.1), similarity_to_confidence(0.6))
        self.assertGreater(similarity_to_confidence(1.0), 0.99)


if __name__ == "__main__":
    unittest.main()
