"""Coverage for the license plate processing mixin (fork D70)."""

import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from frigate.comms.event_metadata_updater import EventMetadataTypeEnum
from frigate.config import FrigateConfig
from frigate.config.classification import ReplaceRule
from frigate.data_processing.common.license_plate.mixin import (
    CTCDecoder,
    LicensePlateProcessingMixin,
)

MIXIN = "frigate.data_processing.common.license_plate.mixin"
CAMERA = "cam"
FRAME_H = 64
FRAME_W = 96


def _build_config() -> FrigateConfig:
    return FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "lpr": {
                "enabled": True,
                "min_area": 10,
                "recognition_threshold": 0.5,
            },
            "cameras": {
                CAMERA: {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {"height": FRAME_H, "width": FRAME_W, "fps": 5},
                    "lpr": {"enabled": True, "min_area": 10},
                }
            },
        }
    )


_CONFIG: FrigateConfig | None = None


def _shared_config() -> FrigateConfig:
    """Build the config once; it takes about a second to validate."""
    global _CONFIG
    if _CONFIG is None:
        _CONFIG = _build_config()
    return _CONFIG


def _metric() -> SimpleNamespace:
    return SimpleNamespace(value=0.0)


class _Processor(LicensePlateProcessingMixin):
    """Concrete consumer of the mixin with mocked collaborators."""

    def __init__(self, config: FrigateConfig) -> None:
        self.config = config
        self.lpr_config = config.lpr
        self.metrics = SimpleNamespace(  # type: ignore[assignment]
            alpr_speed=_metric(),
            alpr_pps=_metric(),
            yolov9_lpr_speed=_metric(),
            yolov9_lpr_pps=_metric(),
        )
        self.model_runner = MagicMock()
        self.requestor = MagicMock()
        self.detected_license_plates = {}
        self.camera_current_cars = {}
        self.sub_label_publisher = MagicMock()
        with patch(f"{MIXIN}.EventMetadataPublisher"):
            super().__init__()
        # the model cache dictionary is not present in tests, pin the default
        self.ctc_decoder = CTCDecoder()


def _ctc_output(decoder: CTCDecoder, text: str, prob: float = 0.95) -> np.ndarray:
    """Build a CTC probability matrix whose best path decodes to text."""
    num_classes = len(decoder.characters)
    steps = 2 * len(text) + 1
    output = np.full((steps, num_classes), 0.001, dtype=np.float32)
    output[0, 0] = prob
    for i, char in enumerate(text):
        output[2 * i + 1, decoder.characters.index(char)] = prob
        output[2 * i + 2, 0] = prob
    return output


def _yuv_frame() -> np.ndarray:
    rng = np.random.default_rng(7)
    return rng.integers(0, 255, (FRAME_H * 3 // 2, FRAME_W), dtype=np.uint8)


def _plate_bitmap() -> np.ndarray:
    """Detection model output with one confident text region well inside."""
    bitmap = np.zeros((1, 128, 160), dtype=np.float32)
    bitmap[0, 40:61, 30:111] = 0.9
    return bitmap


def _rect(x1: int, y1: int, x2: int, y2: int) -> np.ndarray:
    return np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.int32)


class _ProcessorTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.config = _shared_config()
        self.proc = _Processor(self.config)

    def set_attr(self, obj: Any, name: str, value: Any) -> None:
        """Temporarily override a config attribute for one test."""
        original = getattr(obj, name)
        setattr(obj, name, value)
        self.addCleanup(setattr, obj, name, original)


class TestInit(_ProcessorTestCase):
    def test_init_collects_plate_objects_and_defaults(self) -> None:
        self.assertIn("car", self.proc.lp_objects)
        self.assertIn("motorcycle", self.proc.lp_objects)
        self.assertNotIn("person", self.proc.lp_objects)
        self.assertEqual(self.proc.batch_size, 6)
        self.assertEqual(self.proc.min_size, 8)
        self.assertEqual(self.proc.stationary_scan_duration, 5)

    def test_handle_request_returns_none(self) -> None:
        self.assertIsNone(self.proc.handle_request("topic", {}))

    def test_lpr_expire_removes_tracked_plate(self) -> None:
        self.proc.detected_license_plates["a"] = {"camera": CAMERA}
        self.proc.camera_current_cars[CAMERA] = ["a", "b"]

        self.proc.lpr_expire("a", CAMERA)
        self.proc.lpr_expire("missing", CAMERA)

        self.assertEqual(self.proc.detected_license_plates, {})
        self.assertEqual(self.proc.camera_current_cars[CAMERA], ["b"])

    def test_lpr_expire_without_camera_entry(self) -> None:
        self.proc.detected_license_plates["a"] = {"camera": CAMERA}
        self.proc.lpr_expire("a", "other")
        self.assertNotIn("a", self.proc.detected_license_plates)


class TestImageHelpers(_ProcessorTestCase):
    def test_zero_pad_small_image(self) -> None:
        image = np.full((10, 20, 3), 7, dtype=np.uint8)
        padded = self.proc._zero_pad(image)
        self.assertEqual(padded.shape, (32, 32, 3))
        self.assertTrue((padded[:10, :20] == 7).all())
        self.assertEqual(int(padded[10:].sum()) + int(padded[:, 20:].sum()), 0)

    def test_zero_pad_keeps_large_dimensions(self) -> None:
        image = np.ones((40, 50, 3), dtype=np.uint8)
        self.assertEqual(self.proc._zero_pad(image).shape, (40, 50, 3))

    def test_resize_image_rounds_to_multiples_of_32(self) -> None:
        resized = self.proc._resize_image(np.zeros((100, 50, 3), dtype=np.uint8))
        self.assertEqual(resized.shape, (96, 64, 3))

    def test_resize_image_caps_at_max_size(self) -> None:
        resized = self.proc._resize_image(np.zeros((2000, 1000, 3), dtype=np.uint8))
        self.assertEqual(resized.shape, (960, 480, 3))

    def test_resize_image_has_32_pixel_floor(self) -> None:
        resized = self.proc._resize_image(np.zeros((10, 10, 3), dtype=np.uint8))
        self.assertEqual(resized.shape, (32, 32, 3))

    def test_normalize_image_applies_mean_and_std(self) -> None:
        image = np.zeros((2, 3, 3), dtype=np.uint8)
        image[:, :] = [124, 116, 104]
        normalized = self.proc._normalize_image(image)
        self.assertEqual(normalized.shape, (1, 3, 2, 3))
        self.assertAlmostEqual(
            float(normalized[0, 0, 0, 0]), (124 - 123.675) / 58.395, places=4
        )
        self.assertAlmostEqual(
            float(normalized[0, 1, 1, 2]), (116 - 116.28) / 57.12, places=4
        )

    def test_crop_license_plate_horizontal(self) -> None:
        image = np.zeros((40, 100, 3), dtype=np.uint8)
        image[5:35, 10:90] = 200
        crop = self.proc._crop_license_plate(image, _rect(10, 5, 90, 35))
        self.assertEqual(crop.shape, (30, 80, 3))
        self.assertGreater(float(crop.mean()), 150)

    def test_crop_license_plate_rotates_tall_crops(self) -> None:
        image = np.zeros((80, 100, 3), dtype=np.uint8)
        crop = self.proc._crop_license_plate(image, _rect(10, 0, 30, 60))
        self.assertEqual(crop.shape, (20, 60, 3))

    def test_crop_license_plate_requires_four_points(self) -> None:
        with self.assertRaises(AssertionError):
            self.proc._crop_license_plate(
                np.zeros((10, 10, 3), dtype=np.uint8), np.zeros((3, 2))
            )

    def test_preprocess_classification_image(self) -> None:
        image = np.full((20, 40, 3), 255, dtype=np.uint8)
        processed = self.proc._preprocess_classification_image(image)
        self.assertEqual(processed.shape, (3, 48, 192))
        self.assertTrue(np.allclose(processed[:, :, :96], 1.0))
        self.assertTrue(np.allclose(processed[:, :, 96:], 0.0))

    def test_preprocess_classification_image_caps_width(self) -> None:
        image = np.zeros((10, 400, 3), dtype=np.uint8)
        processed = self.proc._preprocess_classification_image(image)
        self.assertEqual(processed.shape, (3, 48, 192))
        self.assertTrue(np.allclose(processed, -1.0))

    def test_clockwise_order(self) -> None:
        points = np.array([[90, 40], [10, 10], [10, 40], [90, 10]])
        ordered = self.proc._clockwise_order(points)
        np.testing.assert_array_equal(ordered, _rect(10, 10, 90, 40))

    def test_is_valid_polygon(self) -> None:
        self.assertTrue(self.proc._is_valid_polygon(_rect(1, 1, 20, 20), 50, 50))
        self.assertFalse(self.proc._is_valid_polygon(_rect(-1, 1, 20, 20), 50, 50))
        self.assertFalse(self.proc._is_valid_polygon(_rect(1, 1, 50, 20), 50, 50))
        self.assertFalse(self.proc._is_valid_polygon(_rect(1, 1, 20, 60), 50, 50))
        self.assertFalse(self.proc._is_valid_polygon(_rect(1, 1, 3, 20), 50, 50))
        self.assertFalse(self.proc._is_valid_polygon(_rect(1, 1, 20, 3), 50, 50))

    def test_filter_polygon_keeps_valid_boxes_in_clockwise_order(self) -> None:
        shuffled = np.array([[30, 25], [5, 5], [30, 5], [5, 25]])
        kept = self.proc._filter_polygon(
            [shuffled, _rect(0, 0, 100, 10), _rect(1, 1, 2, 2)], (40, 50)
        )
        self.assertEqual(len(kept), 1)
        np.testing.assert_array_equal(kept[0], _rect(5, 5, 30, 25))

    def test_sort_boxes_orders_rows_then_columns(self) -> None:
        a = _rect(50, 10, 60, 20)
        b = _rect(10, 12, 20, 22)
        c = _rect(5, 40, 15, 50)
        ordered = self.proc._sort_boxes([c, a, b])
        self.assertIs(ordered[0], b)
        self.assertIs(ordered[1], a)
        self.assertIs(ordered[2], c)

    def test_get_min_boxes_axis_aligned(self) -> None:
        contour = np.array(
            [[[10, 5]], [[50, 5]], [[50, 25]], [[10, 25]]], dtype=np.int32
        )
        box, side = self.proc._get_min_boxes(contour)
        self.assertEqual(len(box), 4)
        self.assertAlmostEqual(side, 20.0)
        xs = sorted(float(p[0]) for p in box)
        self.assertEqual(xs, [10.0, 10.0, 50.0, 50.0])

    def test_box_score_averages_inside_contour(self) -> None:
        bitmap = np.zeros((30, 30), dtype=np.float32)
        bitmap[5:15, 5:25] = 1.0
        full = np.array([[5, 5], [24, 5], [24, 14], [5, 14]], dtype=np.int32)
        half = np.array([[5, 5], [24, 5], [24, 24], [5, 24]], dtype=np.int32)
        self.assertAlmostEqual(self.proc._box_score(bitmap, full), 1.0)
        self.assertAlmostEqual(self.proc._box_score(bitmap, half), 0.5, places=1)

    def test_expand_box_grows_polygon(self) -> None:
        expanded = self.proc._expand_box([(0, 0), (10, 0), (10, 10), (0, 10)])
        self.assertEqual(expanded.shape[1], 2)
        self.assertLess(expanded[:, 0].min(), 0)
        self.assertGreater(expanded[:, 0].max(), 10)
        self.assertLess(expanded[:, 1].min(), 0)
        self.assertGreater(expanded[:, 1].max(), 10)


class TestMergeNearbyBoxes(_ProcessorTestCase):
    def test_empty(self) -> None:
        self.assertEqual(self.proc._merge_nearby_boxes([], plate_width=100), [])

    def test_merges_close_boxes(self) -> None:
        merged = self.proc._merge_nearby_boxes(
            [_rect(55, 10, 100, 30), _rect(0, 12, 50, 32)], plate_width=100
        )
        self.assertEqual(len(merged), 1)
        np.testing.assert_array_equal(merged[0], _rect(0, 10, 100, 32))

    def test_keeps_distant_boxes(self) -> None:
        merged = self.proc._merge_nearby_boxes(
            [_rect(0, 10, 20, 30), _rect(80, 10, 100, 30)], plate_width=100
        )
        self.assertEqual(len(merged), 2)

    def test_keeps_vertically_separate_boxes(self) -> None:
        merged = self.proc._merge_nearby_boxes(
            [_rect(0, 0, 45, 10), _rect(50, 20, 100, 30)], plate_width=100
        )
        self.assertEqual(len(merged), 2)


class TestBoxesFromBitmap(_ProcessorTestCase):
    def test_extracts_scaled_box_for_confident_region(self) -> None:
        output = np.zeros((64, 160), dtype=np.float32)
        output[16:48, 20:140] = 0.9
        boxes, scores = self.proc._boxes_from_bitmap(output, output > 0.6, 320, 128)
        self.assertEqual(len(boxes), 1)
        self.assertAlmostEqual(scores[0], 0.9, places=2)
        box = boxes[0]
        self.assertEqual(box.dtype, np.int32)
        # coordinates are scaled by 2 in both axes
        self.assertLessEqual(box[:, 0].min(), 40)
        self.assertGreaterEqual(box[:, 0].max(), 278)
        self.assertLessEqual(box[:, 1].max(), 128)

    def test_skips_small_and_low_score_regions(self) -> None:
        output = np.zeros((64, 160), dtype=np.float32)
        output[2:5, 2:5] = 0.9
        output[20:50, 40:120] = 0.2
        mask = output > 0.6
        mask[20:50, 40:120] = True
        boxes, scores = self.proc._boxes_from_bitmap(output, mask, 160, 64)
        self.assertEqual(len(boxes), 0)
        self.assertEqual(scores, [])


class TestCTCDecoder(unittest.TestCase):
    def test_default_characters_and_decoding(self) -> None:
        decoder = CTCDecoder()
        self.assertEqual(decoder.characters[0], "blank")
        self.assertEqual(decoder.char_map[1], "0")

        output = _ctc_output(decoder, "AB1")
        texts, confidences = decoder([output])
        self.assertEqual(texts, ["AB1"])
        self.assertEqual(len(confidences[0]), 3)
        for conf in confidences[0]:
            self.assertAlmostEqual(conf, 0.95, places=4)

    def test_repeated_characters_collapse_without_blank(self) -> None:
        decoder = CTCDecoder()
        a = decoder.characters.index("A")
        output = np.full((4, len(decoder.characters)), 0.001, dtype=np.float32)
        output[0, a] = 0.9
        output[1, a] = 0.9
        output[2, 0] = 0.9
        output[3, a] = 0.8
        texts, confidences = decoder([output])
        self.assertEqual(texts, ["AA"])
        self.assertAlmostEqual(confidences[0][1], 0.8, places=4)

    def test_reads_character_dictionary_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "keys.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("x\n\ny\n")
            decoder = CTCDecoder(character_dict_path=path)
        self.assertEqual(decoder.characters, ["blank", "x", "y", " "])

    def test_missing_dictionary_falls_back_to_default(self) -> None:
        decoder = CTCDecoder(character_dict_path="/nonexistent/keys.txt")
        self.assertIn("Z", decoder.characters)


class TestDetect(_ProcessorTestCase):
    def test_detect_returns_filtered_boxes(self) -> None:
        self.proc.model_runner.detection_model.return_value = [_plate_bitmap()]

        boxes = self.proc._detect(np.zeros((128, 160, 3), dtype=np.uint8), 1)

        self.assertEqual(len(boxes), 1)
        box = boxes[0]
        self.assertLess(box[0][0], box[1][0])
        self.assertLess(box[0][1], box[3][1])
        model_input = self.proc.model_runner.detection_model.call_args[0][0][0]
        self.assertEqual(model_input.shape, (1, 3, 128, 160))

    def test_detect_pads_tiny_images(self) -> None:
        self.proc.model_runner.detection_model.return_value = [
            np.zeros((1, 32, 32), dtype=np.float32)
        ]
        boxes = self.proc._detect(np.zeros((20, 20, 3), dtype=np.uint8), 1)
        self.assertEqual(len(boxes), 0)
        model_input = self.proc.model_runner.detection_model.call_args[0][0][0]
        self.assertEqual(model_input.shape, (1, 3, 32, 32))

    def test_detect_model_error_returns_empty(self) -> None:
        self.proc.model_runner.detection_model.side_effect = RuntimeError("boom")
        with self.assertLogs(MIXIN, level="WARNING") as logs:
            boxes = self.proc._detect(np.zeros((64, 64, 3), dtype=np.uint8), 1)
        self.assertEqual(boxes, [])
        self.assertIn("box detection model", logs.output[0])


class TestClassify(_ProcessorTestCase):
    def _images(self) -> list[np.ndarray]:
        a = np.zeros((20, 40, 3), dtype=np.uint8)
        a[:10] = 255
        b = np.zeros((20, 80, 3), dtype=np.uint8)
        return [a, b]

    def test_classify_rotates_confident_180_results(self) -> None:
        images = self._images()
        original_a = images[0].copy()
        self.proc.model_runner.classification_model.return_value = [
            np.array([0.2, 0.8]),
            np.array([0.9, 0.1]),
        ]

        result = self.proc._classify(images)

        self.assertIsNotNone(result)
        out_images, labels = result
        self.assertEqual(labels[0][0], "180")
        self.assertAlmostEqual(float(labels[0][1]), 0.8)
        self.assertEqual(labels[1][0], "0")
        np.testing.assert_array_equal(
            out_images[0], cv2.rotate(original_a, cv2.ROTATE_180)
        )
        batch = self.proc.model_runner.classification_model.call_args[0][0]
        self.assertEqual(len(batch), 2)
        self.assertEqual(batch[0].shape, (1, 3, 48, 192))

    def test_low_confidence_180_is_not_rotated(self) -> None:
        images = self._images()
        original_a = images[0].copy()
        out_images, labels = self.proc._process_classification_output(
            images, [np.array([0.4, 0.6]), np.array([0.9, 0.1])]
        )
        self.assertEqual(labels[0][0], "180")
        np.testing.assert_array_equal(out_images[0], original_a)

    def test_classify_runs_every_batch_in_sorted_order(self) -> None:
        # B29: only the last batch reached the model and its results were
        # written to the wrong images
        widths = [80, 20, 140, 40, 100, 60, 160, 120]
        images = []
        for width in widths:
            image = np.zeros((20, width, 3), dtype=np.uint8)
            image[:10] = 255
            images.append(image)
        originals = [image.copy() for image in images]
        order = np.argsort([w / 20 for w in widths])
        # sorted position k is "180" when k is odd
        outputs = iter(
            np.array([0.1, 0.9]) if k % 2 else np.array([0.9, 0.1])
            for k in range(len(images))
        )
        model = self.proc.model_runner.classification_model
        model.side_effect = lambda batch: [next(outputs) for _ in batch]

        result = self.proc._classify(images)

        self.assertIsNotNone(result)
        out_images, labels = result
        self.assertEqual([len(c.args[0]) for c in model.call_args_list], [6, 2])
        for k, index in enumerate(order):
            self.assertEqual(labels[index][0], "180" if k % 2 else "0")
            expected = originals[index]
            if k % 2:
                expected = cv2.rotate(expected, cv2.ROTATE_180)
            np.testing.assert_array_equal(out_images[index], expected)

    def test_classify_model_error_returns_none(self) -> None:
        self.proc.model_runner.classification_model.side_effect = RuntimeError("x")
        with self.assertLogs(MIXIN, level="WARNING"):
            self.assertIsNone(self.proc._classify(self._images()))


class TestRecognize(_ProcessorTestCase):
    def test_recognize_decodes_model_output(self) -> None:
        self.proc.model_runner.recognition_model.runner.get_input_width.return_value = 0
        decoder = self.proc.ctc_decoder
        self.proc.model_runner.recognition_model.return_value = [
            _ctc_output(decoder, "AB12"),
            _ctc_output(decoder, "XY", prob=0.6),
        ]
        images = [
            np.zeros((20, 80, 3), dtype=np.uint8),
            np.zeros((10, 100, 3), dtype=np.uint8),
        ]

        texts, confidences = self.proc._recognize(CAMERA, images)

        self.assertEqual(texts, ["AB12", "XY"])
        self.assertAlmostEqual(confidences[1][0], 0.6, places=4)
        batch = self.proc.model_runner.recognition_model.call_args[0][0]
        self.assertEqual(len(batch), 2)
        # the 10:1 plate sets the batch width to 48 * 10
        self.assertEqual(batch[0].shape, (1, 3, 48, 480))

    def test_recognize_runs_every_batch(self) -> None:
        # B29: only the last batch of more than six plates reached the model
        self.proc.model_runner.recognition_model.runner.get_input_width.return_value = 0
        decoder = self.proc.ctc_decoder
        texts = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8"]
        outputs = iter(_ctc_output(decoder, text) for text in texts)
        model = self.proc.model_runner.recognition_model
        model.side_effect = lambda batch: [next(outputs) for _ in batch]
        images = [np.zeros((20, 80, 3), dtype=np.uint8) for _ in texts]

        result, confidences = self.proc._recognize(CAMERA, images)

        self.assertEqual(result, texts)
        self.assertEqual(len(confidences), 8)
        self.assertEqual([len(c.args[0]) for c in model.call_args_list], [6, 2])

    def test_recognize_model_error_returns_empty(self) -> None:
        self.proc.model_runner.recognition_model.side_effect = RuntimeError("x")
        self.proc.model_runner.recognition_model.runner.get_input_width.return_value = 0
        with self.assertLogs(MIXIN, level="WARNING"):
            result = self.proc._recognize(
                CAMERA, [np.zeros((20, 80, 3), dtype=np.uint8)]
            )
        self.assertEqual(result, ([], []))

    def test_preprocess_recognition_uses_model_input_width(self) -> None:
        runner = self.proc.model_runner.recognition_model.runner
        runner.get_input_width.return_value = 200
        image = np.full((20, 40, 3), 255, dtype=np.uint8)
        processed = self.proc._preprocess_recognition_image(CAMERA, image, 4.0)
        self.assertEqual(processed.shape, (3, 48, 200))
        self.assertTrue(np.allclose(processed[:, :, :96], 1.0))
        # padding uses the mean pixel value of the resized image
        self.assertTrue(np.allclose(processed[:, :, 96:], 1.0))

    def test_preprocess_recognition_enhancement_levels(self) -> None:
        self.proc.model_runner.recognition_model.runner.get_input_width.return_value = (
            None
        )
        rng = np.random.default_rng(1)
        image = rng.integers(0, 255, (24, 72, 3), dtype=np.uint8)
        camera_lpr = self.config.cameras[CAMERA].lpr
        outputs = {}
        for level in (0, 2, 4, 7):
            self.set_attr(camera_lpr, "enhancement", level)
            processed = self.proc._preprocess_recognition_image(CAMERA, image, 3.0)
            self.assertEqual(processed.shape, (3, 48, 144))
            outputs[level] = processed
        self.assertFalse(np.allclose(outputs[0], outputs[2]))
        self.assertFalse(np.allclose(outputs[2], outputs[4]))
        self.assertFalse(np.allclose(outputs[4], outputs[7]))

    def test_preprocess_recognition_rejects_non_rgb(self) -> None:
        with self.assertRaises(AssertionError):
            self.proc._preprocess_recognition_image(
                CAMERA, np.zeros((10, 10, 1), dtype=np.uint8), 3.0
            )


class TestProcessLicensePlate(_ProcessorTestCase):
    def setUp(self) -> None:
        super().setUp()
        rng = np.random.default_rng(3)
        self.image = rng.integers(0, 255, (60, 200, 3), dtype=np.uint8)
        self.proc._detect = MagicMock()  # type: ignore[method-assign]
        self.proc._recognize = MagicMock()  # type: ignore[method-assign]

    def test_returns_empty_when_runners_not_loaded(self) -> None:
        self.proc.model_runner.recognition_model.runner = None
        self.assertEqual(
            self.proc._process_license_plate(CAMERA, "id", self.image, 1),
            ([], [], []),
        )
        self.proc._detect.assert_not_called()

    def test_returns_empty_when_no_boxes(self) -> None:
        self.proc._detect.return_value = []
        self.assertEqual(
            self.proc._process_license_plate(CAMERA, "id", self.image, 1),
            ([], [], []),
        )
        self.proc._recognize.assert_not_called()

    def test_separate_rows_become_separate_plates(self) -> None:
        self.proc._detect.return_value = [
            _rect(10, 5, 150, 25),
            _rect(10, 35, 150, 55),
        ]
        self.proc._recognize.side_effect = [
            (["AB"], [[0.9, 0.9]]),
            (["CD12"], [[0.95, 0.95, 0.95, 0.95]]),
        ]

        plates, confs, areas = self.proc._process_license_plate(
            CAMERA, "id", self.image, 1
        )

        self.assertEqual(self.proc._recognize.call_count, 2)
        # equal areas, so the longer plate wins the tiebreak
        self.assertEqual(plates, ["CD12", "AB"])
        self.assertEqual(confs[1], [0.9, 0.9])
        self.assertEqual(areas, [2800, 2800])

    def test_same_row_boxes_filter_by_threshold_and_join(self) -> None:
        self.proc._detect.return_value = [
            _rect(10, 10, 50, 40),
            _rect(150, 10, 190, 40),
        ]
        self.proc._recognize.side_effect = [
            (["AB", "12"], [[0.9, 0.9], [0.3, 0.3]]),
        ]
        plates, confs, areas = self.proc._process_license_plate(
            CAMERA, "id", self.image, 1
        )
        self.assertEqual(plates, ["AB"])
        self.assertEqual(confs, [[0.9, 0.9]])
        self.assertEqual(areas, [1200])

        self.proc._recognize.side_effect = [
            (["AB", "12"], [[0.9, 0.9], [0.8, 0.8]]),
        ]
        plates, confs, areas = self.proc._process_license_plate(
            CAMERA, "id", self.image, 1
        )
        self.assertEqual(plates, ["AB 12"])
        self.assertEqual(confs, [[0.9, 0.9, 0.8, 0.8]])
        self.assertEqual(areas, [2400])

    def test_low_confidence_and_empty_results_are_dropped(self) -> None:
        self.proc._detect.return_value = [_rect(10, 10, 150, 40)]
        for recognized in (
            ([], []),
            (["AB12"], [[0.1, 0.1]]),
            (["AB12"], []),
            (["AB12"], [[]]),
        ):
            self.proc._recognize.side_effect = [recognized]
            self.assertEqual(
                self.proc._process_license_plate(CAMERA, "id", self.image, 1),
                ([], [], []),
            )

    def test_replace_rules_are_applied(self) -> None:
        self.proc.lpr_config = self.config.lpr.model_copy(
            update={
                "replace_rules": [
                    ReplaceRule(pattern="B", replacement="8"),
                    ReplaceRule(pattern="", replacement="ignored"),
                    ReplaceRule(pattern="(", replacement="x"),
                ]
            }
        )
        self.proc._detect.return_value = [_rect(10, 10, 150, 40)]
        self.proc._recognize.side_effect = [(["AB12"], [[0.9] * 4])]

        with self.assertLogs(MIXIN, level="WARNING") as logs:
            plates, _, _ = self.proc._process_license_plate(CAMERA, "id", self.image, 1)

        self.assertEqual(plates, ["A812"])
        self.assertIn("Invalid regex", logs.output[0])

    def test_debug_save_plates_writes_crops(self) -> None:
        self.set_attr(self.config.lpr, "debug_save_plates", True)
        self.proc._detect.return_value = [_rect(10, 10, 150, 40)]
        self.proc._recognize.side_effect = [(["AB12"], [[0.9] * 4])]

        with tempfile.TemporaryDirectory() as tmp:
            with patch(f"{MIXIN}.CLIPS_DIR", tmp):
                plates, _, _ = self.proc._process_license_plate(
                    CAMERA, "evt", self.image, 42
                )
            saved = os.listdir(os.path.join(tmp, "lpr", CAMERA, "evt"))

        self.assertEqual(plates, ["AB12"])
        self.assertEqual(saved, ["42_1.jpg"])


class TestProcessLicensePlateEndToEnd(_ProcessorTestCase):
    def test_detection_and_recognition_models(self) -> None:
        runner = self.proc.model_runner
        runner.detection_model.return_value = [_plate_bitmap()]
        runner.recognition_model.runner.get_input_width.return_value = 0
        runner.recognition_model.side_effect = lambda batch: [
            _ctc_output(self.proc.ctc_decoder, "ABC123") for _ in batch
        ]

        image = np.zeros((128, 160, 3), dtype=np.uint8)
        plates, confs, areas = self.proc._process_license_plate(CAMERA, "id", image, 1)

        self.assertEqual(plates, ["ABC123"])
        self.assertEqual(len(confs[0]), 6)
        self.assertGreater(areas[0], 0)


class TestDetectLicensePlate(_ProcessorTestCase):
    def test_model_error_returns_none(self) -> None:
        self.proc.model_runner.yolov9_detection_model.side_effect = RuntimeError("x")
        with self.assertLogs(MIXIN, level="WARNING"):
            self.assertIsNone(
                self.proc._detect_license_plate(
                    CAMERA, np.zeros((100, 200, 3), dtype=np.uint8)
                )
            )

    def test_wide_image_picks_top_box_and_expands(self) -> None:
        self.proc.model_runner.yolov9_detection_model.return_value = [
            np.array([0, 0, 64, 10, 74, 0, 0.8], dtype=np.float64),
            np.array([0, 64, 96, 192, 160, 0, 0.9], dtype=np.float64),
            np.array([0, 0, 64, 256, 192, 0, 0.1], dtype=np.float64),
        ]
        box = self.proc._detect_license_plate(
            CAMERA, np.zeros((100, 200, 3), dtype=np.uint8)
        )
        self.assertEqual(box, (45, 22, 155, 77))

    def test_tall_image_offsets_x(self) -> None:
        self.proc.model_runner.yolov9_detection_model.return_value = [
            np.array([0, 64, 0, 192, 256, 0, 0.9], dtype=np.float64),
        ]
        box = self.proc._detect_license_plate(
            CAMERA, np.zeros((200, 100, 3), dtype=np.uint8)
        )
        # the box spans the full image and the expansion is clipped
        self.assertEqual(box, (0, 0, 100, 200))

    def test_no_confident_prediction(self) -> None:
        self.proc.model_runner.yolov9_detection_model.return_value = [
            np.array([0, 0, 0, 10, 10, 0, 0.2], dtype=np.float64),
        ]
        self.assertIsNone(
            self.proc._detect_license_plate(
                CAMERA, np.zeros((100, 200, 3), dtype=np.uint8)
            )
        )


def _variant(plate: str, conf: float, area: int = 100) -> dict[str, Any]:
    return {"plate": plate, "conf": conf, "char_confidences": [conf], "area": area}


class TestClusterAndFilters(_ProcessorTestCase):
    def test_cluster_rep_empty_and_single(self) -> None:
        self.assertEqual(self.proc._get_cluster_rep([]), ("", 0.0, [], 0))
        self.assertEqual(
            self.proc._get_cluster_rep([_variant("ABC123", 0.9, 50)]),
            ("ABC123", 0.9, [0.9], 50),
        )

    def test_cluster_rep_prefers_largest_cluster(self) -> None:
        plates = [
            _variant("ABC123", 0.8, 10),
            _variant("XYZ999", 0.99, 20),
            _variant("ABC128", 0.85, 30),
            _variant("ABC123", 0.7, 40),
        ]
        self.assertEqual(
            self.proc._get_cluster_rep(plates), ("ABC128", 0.85, [0.85], 30)
        )

    def test_cluster_rep_tie_breaks_by_confidence(self) -> None:
        plates = [_variant("ABC123", 0.8), _variant("XYZ999", 0.9)]
        self.assertEqual(self.proc._get_cluster_rep(plates)[0], "XYZ999")

    def test_passes_plate_filters(self) -> None:
        self.assertFalse(self.proc._passes_plate_filters(CAMERA, "AB"))
        self.assertTrue(self.proc._passes_plate_filters(CAMERA, "ABCD"))

        self.proc.lpr_config = self.config.lpr.model_copy(
            update={"format": "^[A-Z]{3}[0-9]{3}$"}
        )
        self.assertTrue(self.proc._passes_plate_filters(CAMERA, "ABC123"))
        self.assertFalse(self.proc._passes_plate_filters(CAMERA, "ABCD12"))

    def test_invalid_format_regex_passes_with_error(self) -> None:
        self.proc.lpr_config = self.config.lpr.model_copy(update={"format": "("})
        with self.assertLogs(MIXIN, level="ERROR"):
            self.assertTrue(self.proc._passes_plate_filters(CAMERA, "ABC123"))

    def test_generate_plate_event_publishes(self) -> None:
        event_id = self.proc._generate_plate_event(CAMERA, "ABC123", 0.9)
        timestamp, rand = event_id.rsplit("-", 1)
        self.assertGreater(float(timestamp), 0)
        self.assertEqual(len(rand), 6)
        payload, topic = self.proc.event_metadata_publisher.publish.call_args[0]
        self.assertEqual(topic, EventMetadataTypeEnum.lpr_event_create.value)
        self.assertEqual(
            payload[1:], (CAMERA, "license_plate", event_id, True, 0.9, None, "ABC123")
        )


class _LprProcessTestCase(_ProcessorTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frame = _yuv_frame()
        self.proc._process_license_plate = MagicMock(  # type: ignore[method-assign]
            return_value=(["ABC123"], [[0.95] * 6], [500])
        )
        self.proc._detect_license_plate = MagicMock(  # type: ignore[method-assign]
            return_value=(20, 20, 120, 60)
        )

    def car(self, **extra: Any) -> dict[str, Any]:
        data = {
            "id": "car1",
            "camera": CAMERA,
            "label": "car",
            "position_changes": 1,
            "box": (10, 10, 90, 60),
        }
        data.update(extra)
        return data

    def published_update(self) -> dict[str, Any]:
        topic, payload = self.proc.requestor.send_data.call_args[0]
        self.assertEqual(topic, "tracked_object_update")
        return json.loads(payload)

    def track_license_plates(self) -> None:
        objects = self.config.cameras[CAMERA].objects
        self.set_attr(objects, "track", ["person", "car", "license_plate"])


class TestLprProcessGates(_LprProcessTestCase):
    def test_disabled_camera_returns(self) -> None:
        self.set_attr(self.config.cameras[CAMERA].lpr, "enabled", False)
        self.proc.lpr_process(self.car(), self.frame)
        self.proc._process_license_plate.assert_not_called()

    def test_metrics_are_refreshed(self) -> None:
        self.set_attr(self.config.cameras[CAMERA].lpr, "enabled", False)
        self.proc.metrics.alpr_pps.value = None
        self.proc.metrics.yolov9_lpr_pps.value = None
        self.proc.lpr_process(self.car(), self.frame)
        self.assertIsNotNone(self.proc.metrics.alpr_pps.value)
        self.assertIsNotNone(self.proc.metrics.yolov9_lpr_pps.value)

    def test_non_plate_label_returns(self) -> None:
        self.proc.lpr_process(self.car(label="person"), self.frame)
        self.proc._detect_license_plate.assert_not_called()

    def test_new_moving_object_without_position_changes_returns(self) -> None:
        self.proc.lpr_process(self.car(position_changes=0), self.frame)
        self.proc._detect_license_plate.assert_not_called()

    def test_long_stationary_objects_are_skipped(self) -> None:
        threshold = self.config.cameras[CAMERA].detect.stationary.threshold
        # 5.5 seconds at 5 fps falls in the one second log window
        for extra_frames in (28, 500):
            self.proc.lpr_process(
                self.car(stationary=True, motionless_count=threshold + extra_frames),
                self.frame,
            )
        self.proc._detect_license_plate.assert_not_called()

    def test_recently_stationary_objects_are_processed(self) -> None:
        threshold = self.config.cameras[CAMERA].detect.stationary.threshold
        self.proc.lpr_process(
            self.car(
                position_changes=0, stationary=True, motionless_count=threshold + 5
            ),
            self.frame,
        )
        self.proc._detect_license_plate.assert_called_once()


class TestLprProcessManualDetection(_LprProcessTestCase):
    def test_missing_car_box_returns(self) -> None:
        self.proc.lpr_process(self.car(box=None), self.frame)
        self.proc._detect_license_plate.assert_not_called()

    def test_no_plate_detected_returns(self) -> None:
        self.proc._detect_license_plate.return_value = None
        self.proc.lpr_process(self.car(), self.frame)
        self.proc._process_license_plate.assert_not_called()

    def test_small_plate_returns(self) -> None:
        self.proc._detect_license_plate.return_value = (0, 0, 5, 5)
        self.proc.lpr_process(self.car(), self.frame)
        self.proc._process_license_plate.assert_not_called()

    def test_publishes_recognized_plate(self) -> None:
        self.proc.lpr_process(self.car(), self.frame)

        car_crop = self.proc._detect_license_plate.call_args[0][1]
        self.assertEqual(car_crop.shape, (100, 160, 3))
        args = self.proc._process_license_plate.call_args[0]
        self.assertEqual(args[:2], (CAMERA, "car1"))
        self.assertEqual(args[2].shape, (80, 200, 3))

        update = self.published_update()
        self.assertEqual(update["type"], "lpr")
        self.assertEqual(update["plate"], "ABC123")
        self.assertIsNone(update["name"])
        self.assertEqual(update["id"], "car1")
        self.assertEqual(update["plate_box"], [20, 20, 70, 40])
        self.assertAlmostEqual(update["score"], 0.95)

        self.proc.sub_label_publisher.publish.assert_called_once()
        payload, topic = self.proc.sub_label_publisher.publish.call_args[0]
        self.assertEqual(topic, EventMetadataTypeEnum.attribute.value)
        self.assertEqual(payload[:3], ("car1", "recognized_license_plate", "ABC123"))

        stored = self.proc.detected_license_plates["car1"]
        self.assertEqual(stored["plate"], "ABC123")
        self.assertIsNone(stored["last_seen"])
        self.assertEqual(stored["obj_data"]["id"], "car1")
        self.assertEqual(self.proc.camera_current_cars[CAMERA], ["car1"])

        # a second pass does not register the car again
        self.proc.lpr_process(self.car(), self.frame)
        self.assertEqual(self.proc.camera_current_cars[CAMERA], ["car1"])
        self.assertEqual(len(self.proc.detected_license_plates["car1"]["plates"]), 2)

    def test_known_plate_publishes_sub_label(self) -> None:
        self.proc.lpr_config = self.config.lpr.model_copy(
            update={"known_plates": {"Bob": ["ABC12."], "Ann": ["ZZZ"]}}
        )
        self.proc.lpr_process(self.car(), self.frame)

        payload, topic = self.proc.sub_label_publisher.publish.call_args_list[0][0]
        self.assertEqual(topic, EventMetadataTypeEnum.sub_label.value)
        self.assertEqual(payload[:2], ("car1", "Bob"))
        self.assertAlmostEqual(payload[2], 0.95)
        self.assertEqual(self.published_update()["name"], "Bob")

    def test_known_plate_matches_by_edit_distance(self) -> None:
        self.proc.lpr_config = self.config.lpr.model_copy(
            update={"known_plates": {"Bob": ["ABC124"]}}
        )
        self.proc.lpr_process(self.car(), self.frame)
        self.assertEqual(self.published_update()["name"], "Bob")

    def test_invalid_known_plate_regex_logs_error(self) -> None:
        self.proc.lpr_config = self.config.lpr.model_copy(
            update={"known_plates": {"Bad": ["("]}}
        )
        with self.assertLogs(MIXIN, level="ERROR"):
            self.proc.lpr_process(self.car(), self.frame)
        self.assertIsNone(self.published_update()["name"])

    def test_no_text_returns(self) -> None:
        self.proc._process_license_plate.return_value = ([], [], [])
        self.proc.lpr_process(self.car(), self.frame)
        self.proc.requestor.send_data.assert_not_called()

    def test_low_confidence_returns(self) -> None:
        self.proc._process_license_plate.return_value = (["ABC123"], [[0.1]], [10])
        self.proc.lpr_process(self.car(), self.frame)
        self.proc.requestor.send_data.assert_not_called()

    def test_empty_confidences_count_as_zero(self) -> None:
        self.proc._process_license_plate.return_value = (["ABC123"], [[]], [10])
        self.proc.lpr_process(self.car(), self.frame)
        self.proc.requestor.send_data.assert_not_called()

    def test_short_plate_is_stored_but_not_published(self) -> None:
        self.proc._process_license_plate.return_value = (["AB"], [[0.9, 0.9]], [10])
        self.proc.lpr_process(self.car(), self.frame)
        self.proc.requestor.send_data.assert_not_called()
        self.assertEqual(len(self.proc.detected_license_plates["car1"]["plates"]), 1)

    def test_variants_are_pruned(self) -> None:
        self.proc.detected_license_plates["car1"] = {
            "camera": CAMERA,
            "plates": [_variant("ABC123", 0.9) for _ in range(30)],
        }
        self.proc.lpr_process(self.car(), self.frame)
        # 5 fps * 5 seconds of variants are kept
        self.assertEqual(len(self.proc.detected_license_plates["car1"]["plates"]), 25)

    def test_clustering_can_override_top_plate(self) -> None:
        self.proc.detected_license_plates["car1"] = {
            "camera": CAMERA,
            "plates": [_variant("XYZ789", 0.99), _variant("XYZ789", 0.98)],
        }
        self.proc.lpr_process(self.car(), self.frame)
        self.assertEqual(self.published_update()["plate"], "XYZ789")


class TestLprProcessAttributes(_LprProcessTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.track_license_plates()

    def test_car_without_attributes_returns(self) -> None:
        self.proc.lpr_process(self.car(current_attributes=[]), self.frame)
        self.proc._process_license_plate.assert_not_called()

    def test_car_without_plate_attribute_returns(self) -> None:
        self.proc.lpr_process(
            self.car(current_attributes=[{"label": "fedex", "box": (0, 0, 9, 9)}]),
            self.frame,
        )
        self.proc._process_license_plate.assert_not_called()

    def test_best_plate_attribute_is_cropped(self) -> None:
        attributes = [
            {"label": "fedex", "score": 0.99, "box": (0, 0, 9, 9)},
            {"label": "license_plate", "score": 0.6, "box": (0, 0, 30, 30)},
            {"label": "license_plate", "score": 0.8, "box": (20, 10, 60, 30)},
        ]
        self.proc.lpr_process(self.car(current_attributes=attributes), self.frame)

        frame = self.proc._process_license_plate.call_args[0][2]
        self.assertEqual(frame.shape, (48, 96, 3))
        self.assertEqual(self.published_update()["plate_box"], [16, 8, 64, 32])
        self.proc._detect_license_plate.assert_not_called()

    def test_dedicated_plate_object_uses_own_box(self) -> None:
        obj = {
            "id": "lp1",
            "camera": CAMERA,
            "label": "license_plate",
            "position_changes": 2,
            "box": (20, 10, 60, 30),
        }
        self.proc.lpr_process(obj, self.frame)
        self.assertEqual(self.published_update()["id"], "lp1")
        self.assertEqual(self.published_update()["plate_box"], [16, 8, 64, 32])

    def test_small_plate_box_returns(self) -> None:
        attributes = [{"label": "license_plate", "score": 0.8, "box": (1, 1, 2, 2)}]
        self.proc.lpr_process(self.car(current_attributes=attributes), self.frame)
        self.proc._process_license_plate.assert_not_called()

    def test_plate_without_a_box_returns(self) -> None:
        # B29: the min_area log line called area(None) and raised TypeError
        attributes = [{"label": "license_plate", "score": 0.8, "box": None}]
        self.proc.lpr_process(self.car(current_attributes=attributes), self.frame)

        plate = {"id": "lp1", "camera": CAMERA, "label": "license_plate"}
        self.proc.lpr_process({**plate, "position_changes": 2}, self.frame)

        self.proc._process_license_plate.assert_not_called()

    def test_dedicated_camera_with_plus_model_keeps_fixed_id(self) -> None:
        self.proc._detect_license_plate.return_value = (10, 10, 50, 30)
        self.proc.lpr_process(CAMERA, self.frame, dedicated_lpr=True)  # type: ignore[arg-type]
        self.assertEqual(self.published_update()["id"], "dedicated-lpr")
        self.proc.event_metadata_publisher.publish.assert_not_called()
        topics = [c[0][1] for c in self.proc.sub_label_publisher.publish.call_args_list]
        self.assertNotIn(EventMetadataTypeEnum.save_lpr_snapshot.value, topics)


class TestLprProcessDedicated(_LprProcessTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.proc._detect_license_plate.return_value = (10, 10, 50, 30)

    def run_dedicated(self) -> None:
        self.proc.lpr_process(CAMERA, self.frame, dedicated_lpr=True)  # type: ignore[arg-type]

    def test_no_plate_returns(self) -> None:
        self.proc._detect_license_plate.return_value = None
        self.run_dedicated()
        self.proc._process_license_plate.assert_not_called()

    def test_small_plate_returns(self) -> None:
        self.proc._detect_license_plate.return_value = (0, 0, 2, 2)
        self.run_dedicated()
        self.proc._process_license_plate.assert_not_called()

    def test_new_plate_creates_event_and_snapshot(self) -> None:
        self.run_dedicated()

        args = self.proc._process_license_plate.call_args[0]
        self.assertEqual(args[1], "dedicated-lpr")
        self.assertEqual(args[2].shape, (40, 80, 3))

        self.proc.event_metadata_publisher.publish.assert_called_once()
        event_id = self.proc.event_metadata_publisher.publish.call_args[0][0][3]
        stored = self.proc.detected_license_plates[event_id]
        self.assertEqual(stored["plate"], "ABC123")
        self.assertIsNotNone(stored["last_seen"])
        self.assertNotIn("obj_data", stored)
        self.assertEqual(self.proc.camera_current_cars[CAMERA], [event_id])

        update = self.published_update()
        self.assertEqual(update["id"], event_id)
        self.assertEqual(update["plate_box"], [10, 10, 50, 30])

        snapshot = self.proc.sub_label_publisher.publish.call_args_list[-1][0]
        self.assertEqual(snapshot[1], EventMetadataTypeEnum.save_lpr_snapshot.value)
        self.assertEqual(snapshot[0][1:], (event_id, CAMERA))
        self.assertTrue(snapshot[0][0])

    def test_similar_plate_matches_existing_event(self) -> None:
        self.run_dedicated()
        event_id = next(iter(self.proc.detected_license_plates))

        self.proc._process_license_plate.return_value = (
            ["ABC128"],
            [[0.9] * 6],
            [500],
        )
        self.run_dedicated()

        self.proc.event_metadata_publisher.publish.assert_called_once()
        self.assertEqual(list(self.proc.detected_license_plates), [event_id])
        self.assertEqual(len(self.proc.detected_license_plates[event_id]["plates"]), 2)

    def test_entries_without_last_seen_are_ignored(self) -> None:
        self.proc.detected_license_plates["car1"] = {
            "camera": CAMERA,
            "plate": "ABC123",
            "plates": [],
        }
        self.proc.detected_license_plates["other"] = {
            "camera": "elsewhere",
            "plate": "ABC123",
            "last_seen": 0,
            "plates": [],
        }
        self.run_dedicated()
        self.proc.event_metadata_publisher.publish.assert_called_once()
        self.assertEqual(len(self.proc.detected_license_plates), 3)

    def test_dissimilar_plate_creates_second_event(self) -> None:
        self.run_dedicated()
        self.proc._process_license_plate.return_value = (
            ["XYZ789"],
            [[0.9] * 6],
            [500],
        )
        self.run_dedicated()
        self.assertEqual(self.proc.event_metadata_publisher.publish.call_count, 2)
        self.assertEqual(len(self.proc.camera_current_cars[CAMERA]), 2)

    def test_new_plate_failing_filters_creates_nothing(self) -> None:
        self.proc._process_license_plate.return_value = (["AB"], [[0.9, 0.9]], [10])
        self.run_dedicated()
        self.proc.event_metadata_publisher.publish.assert_not_called()
        self.assertEqual(self.proc.detected_license_plates, {})
        self.proc.requestor.send_data.assert_not_called()


if __name__ == "__main__":
    unittest.main()
