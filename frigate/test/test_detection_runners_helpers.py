"""Tests for the accelerated runner fallbacks and the OpenVINO compile retry."""

import unittest
from unittest.mock import MagicMock, patch

from frigate.detectors import detection_runners
from frigate.detectors.detection_runners import (
    OpenVINOModelRunner,
    _get_rknn_runner,
    get_optimized_runner,
    loaded_devices,
)


class TestRknnRunner(unittest.TestCase):
    def test_an_incompatible_model_is_not_converted(self):
        with (
            patch.object(detection_runners, "is_rknn_compatible", return_value=False),
            patch.object(detection_runners, "auto_convert_model") as convert,
        ):
            self.assertIsNone(_get_rknn_runner("/models/m.onnx"))

        convert.assert_not_called()

    def test_a_failed_conversion_gives_no_runner(self):
        with (
            patch.object(detection_runners, "is_rknn_compatible", return_value=True),
            patch.object(detection_runners, "auto_convert_model", return_value=None),
        ):
            self.assertIsNone(_get_rknn_runner("/models/m.onnx"))

    def test_a_converted_model_runs_on_rknn(self):
        with (
            patch.object(detection_runners, "is_rknn_compatible", return_value=True),
            patch.object(
                detection_runners, "auto_convert_model", return_value="/m.rknn"
            ),
            patch.object(detection_runners, "RKNNModelRunner") as runner,
        ):
            self.assertIs(_get_rknn_runner("/models/m.onnx"), runner.return_value)

        runner.assert_called_once_with("/m.rknn")


class TestOptimizedRunnerAcceleration(unittest.TestCase):
    def setUp(self):
        loaded_devices.clear()
        self.addCleanup(loaded_devices.clear)

    def test_the_rknn_runner_wins_and_is_recorded(self):
        rknn = MagicMock(device_name="RKNN")

        with (
            patch.object(detection_runners, "_get_rknn_runner", return_value=rknn),
            patch.object(detection_runners, "_get_ane_runner") as ane,
        ):
            runner = get_optimized_runner("/models/m.onnx", None, "yolo-generic")

        self.assertIs(runner, rknn)
        ane.assert_not_called()
        self.assertEqual(loaded_devices["/models/m.onnx"], ("yolo-generic", "RKNN"))

    def test_the_neural_engine_is_tried_when_rknn_is_not_used(self):
        ane = MagicMock(device_name="Neural Engine")

        with (
            patch.object(detection_runners, "_get_rknn_runner", return_value=None),
            patch.object(detection_runners, "_get_ane_runner", return_value=ane),
        ):
            runner = get_optimized_runner("/models/m.onnx", "GPU", "arcface")

        self.assertIs(runner, ane)
        self.assertEqual(loaded_devices["/models/m.onnx"], ("arcface", "Neural Engine"))

    def test_a_cpu_device_skips_the_accelerators(self):
        session = MagicMock()
        session.get_providers.return_value = ["CPUExecutionProvider"]

        with (
            patch.object(detection_runners, "_get_rknn_runner") as rknn,
            patch.object(detection_runners, "_get_ane_runner") as ane,
            patch.object(
                detection_runners,
                "get_ort_providers",
                return_value=(["CPUExecutionProvider"], [{}]),
            ),
            patch.object(
                detection_runners.ort, "InferenceSession", return_value=session
            ),
            patch.object(
                detection_runners, "get_ort_session_options", return_value=None
            ),
        ):
            get_optimized_runner("/models/m.onnx", "CPU", "arcface")

        rknn.assert_not_called()
        ane.assert_not_called()
        self.assertEqual(loaded_devices["/models/m.onnx"], ("arcface", "CPU"))


class TestOpenVINOCompile(unittest.TestCase):
    def runner(self) -> OpenVINOModelRunner:
        runner = OpenVINOModelRunner.__new__(OpenVINOModelRunner)
        runner.ov_core = MagicMock()
        return runner

    def test_compiles_with_the_compile_config(self):
        runner = self.runner()
        config = {"NPU_TURBO": "YES"}

        compiled = runner._compile_model("/m.xml", "NPU", config)

        self.assertIs(compiled, runner.ov_core.compile_model.return_value)
        runner.ov_core.compile_model.assert_called_once_with(
            model="/m.xml", device_name="NPU", config=config
        )

    def test_a_rejected_compile_config_is_retried_without_it(self):
        runner = self.runner()
        compiled = MagicMock()
        runner.ov_core.compile_model.side_effect = [RuntimeError("turbo"), compiled]

        self.assertIs(
            runner._compile_model("/m.xml", "NPU", {"NPU_TURBO": "YES"}), compiled
        )
        runner.ov_core.compile_model.assert_called_with(
            model="/m.xml", device_name="NPU"
        )

    def test_a_failure_without_compile_config_is_raised(self):
        runner = self.runner()
        runner.ov_core.compile_model.side_effect = RuntimeError("broken")

        with self.assertRaisesRegex(RuntimeError, "broken"):
            runner._compile_model("/m.xml", "GPU", {})

        runner.ov_core.compile_model.assert_called_once()


if __name__ == "__main__":
    unittest.main()
