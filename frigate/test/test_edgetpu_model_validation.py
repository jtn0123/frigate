"""Invalid model metadata should produce a useful configuration error."""

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

import numpy as np

from frigate.detectors.detector_config import ModelTypeEnum
from frigate.detectors.plugins import edgetpu_tfl


class TestEdgeTpuModelValidation(TestCase):
    def test_invalid_yolo_output_count_reports_model_error(self):
        config = SimpleNamespace(
            device=None,
            model=SimpleNamespace(
                path="model.tflite",
                width=320,
                height=320,
                model_type=ModelTypeEnum.yologeneric,
            ),
        )
        for count in (0, 1, 4):
            with self.subTest(count=count):
                interpreter = Mock()
                interpreter.get_input_details.return_value = [{"dtype": np.float32}]
                interpreter.get_output_details.return_value = [{}] * count
                with (
                    patch.object(edgetpu_tfl, "load_delegate"),
                    patch.object(edgetpu_tfl, "Interpreter", return_value=interpreter),
                    self.assertRaisesRegex(
                        ValueError, "YOLO model must have 2 or 3 output tensors"
                    ),
                ):
                    edgetpu_tfl.EdgeTpuTfl(config)
