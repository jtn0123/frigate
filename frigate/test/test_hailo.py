"""Exercise Hailo preparation, async bindings and inference without hardware."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import numpy as np

from frigate.detectors.detector_config import ModelConfig
from frigate.detectors.plugins import hailo


class TestHailo(unittest.TestCase):
    def test_letterbox_preserves_shape_and_pads_batch(self):
        image = np.zeros((1, 10, 20, 3), dtype=np.uint8)
        result = hailo.preprocess_tensor(image, 20, 20)
        self.assertEqual(result.shape, (20, 20, 3))
        np.testing.assert_array_equal(result[:5], 114)
        np.testing.assert_array_equal(result[5:15], 0)
        np.testing.assert_array_equal(result[15:], 114)

    def test_architecture_probe(self):
        for output, code, expected in [
            ("Device Architecture: HAILO8L", 0, "hailo8l"),
            ("Device Architecture: HAILO8", 0, "hailo8"),
            ("unknown", 0, None),
            ("", 1, None),
        ]:
            with (
                self.subTest(output=output),
                patch.object(hailo, "find_tool", return_value="cli"),
                patch.object(
                    hailo.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], code, output, "error"),
                ),
            ):
                self.assertEqual(hailo.detect_hailo_arch(), expected)
        with patch.object(hailo, "find_tool", side_effect=OSError("missing")):
            self.assertIsNone(hailo.detect_hailo_arch())

    def engine(self, output_type=None):
        sdk = MagicMock()
        sdk.FormatType = SimpleNamespace(FLOAT32="FLOAT32")
        sdk.HEF.return_value.get_output_vstream_infos.return_value = [
            SimpleNamespace(
                name="out", format=SimpleNamespace(type="FormatType.FLOAT32")
            )
        ]
        sdk.HEF.return_value.get_input_vstream_infos.return_value = [
            SimpleNamespace(shape=(10, 20, 3))
        ]
        sdk.VDevice.return_value.create_infer_model.return_value.output.return_value.shape = (
            2,
            5,
        )
        with patch.dict(sys.modules, {"hailo_platform": sdk}):
            engine = hailo.HailoAsyncInference(
                "model.hef",
                Mock(),
                Mock(),
                input_type="FLOAT32",
                output_type=output_type,
            )
        return engine, sdk

    def test_formats_and_bindings_preserve_named_output_mapping(self):
        for types in (None, {"out": "FLOAT32"}):
            with self.subTest(types=types):
                engine, sdk = self.engine(types)
                self.assertEqual(engine.output_type, types)
                configured = Mock()
                engine._create_bindings(configured)
                buffers = configured.create_bindings.call_args.kwargs["output_buffers"]
                self.assertEqual(buffers["out"].shape, (2, 5))
                self.assertEqual(buffers["out"].dtype, np.float32)
                self.assertEqual(engine.get_input_shape(), (10, 20, 3))
                sdk.VDevice.return_value.create_infer_model.return_value.input.return_value.set_format_type.assert_called_once_with(
                    "FLOAT32"
                )

    def test_missing_sdk_has_actionable_error(self):
        input_store, output_store = Mock(), Mock()
        with (
            patch.dict(sys.modules, {"hailo_platform": None}),
            self.assertRaisesRegex(ImportError, "installs it at startup"),
        ):
            hailo.HailoAsyncInference("x", input_store, output_store)

    def test_callback_routes_each_request_and_reports_errors(self):
        engine, _ = self.engine()
        bindings = Mock(_output_names=["one"])
        bindings.output.return_value.get_buffer.return_value = np.array([1])
        engine.callback(SimpleNamespace(exception=None), [bindings], ["frame"], [42])
        self.assertEqual(engine.output_store.put.call_args.args[0], 42)
        self.assertEqual(engine.output_store.put.call_args.args[1][0], "frame")
        bindings._output_names = ["one", "two"]
        engine.callback(SimpleNamespace(exception=None), [bindings], ["frame"], [43])
        output = engine.output_store.put.call_args.args[1][1]
        self.assertEqual(set(output), {"one", "two"})
        self.assertEqual(output["one"].shape, (1, 1))
        engine.output_store.put.reset_mock()
        engine.callback(SimpleNamespace(exception="failed"), [], [], [])
        engine.output_store.put.assert_not_called()

    def test_async_loop_submits_then_waits_and_handles_empty_queue(self):
        for has_frame in (True, False):
            engine, _ = self.engine()
            engine.input_store.get.side_effect = (
                [(7, np.ones((10, 20, 3))), None] if has_frame else [None]
            )
            configured = (
                engine.infer_model.configure.return_value.__enter__.return_value
            )
            engine.run()
            if has_frame:
                configured.wait_for_async_ready.assert_called_once_with(
                    timeout_ms=10000
                )
                configured.run_async.return_value.wait.assert_called_once_with(100)
                np.testing.assert_array_equal(
                    configured.create_bindings.return_value.input.return_value.set_buffer.call_args.args[
                        0
                    ],
                    np.ones((10, 20, 3)),
                )
            else:
                configured.run_async.assert_not_called()

    def detector(self):
        detector = object.__new__(hailo.HailoDetector)
        detector.input_shape = (10, 20, 3)
        detector.input_store = Mock()
        detector.response_store = Mock()
        detector.inference_thread = Mock()
        return detector

    def test_model_resolution_and_download_failures(self):
        detector = self.detector()
        with tempfile.TemporaryDirectory() as directory:
            detector.cache_dir = str(Path(directory) / "cache")
            for arch, url in [
                ("hailo8", hailo.H8_DEFAULT_URL),
                ("hailo8l", hailo.H8L_DEFAULT_URL),
            ]:
                with (
                    patch.object(hailo, "ARCH", arch),
                    patch.object(detector, "download_model") as download,
                ):
                    detector.set_path_and_url(None)
                    path = detector.check_and_prepare()
                    download.assert_called_once_with(url, path)
            Path(path).touch()
            with patch.object(detector, "download_model") as download:
                self.assertEqual(detector.check_and_prepare(), path)
                download.assert_not_called()
            detector.set_path_and_url(path)
            self.assertEqual(detector.check_and_prepare(), path)
            detector.set_path_and_url(str(Path(directory) / "missing.hef"))
            with self.assertRaises(FileNotFoundError):
                detector.check_and_prepare()
            detector.set_path_and_url("https://example.com/remote.hef")
            with patch.object(detector, "download_model") as download:
                self.assertTrue(detector.check_and_prepare().endswith("remote.hef"))
                download.assert_called_once()
        for value in ("http://host/m.hef", "https://host/m.hef", "www.host/m.hef"):
            self.assertTrue(detector.is_url(value))
        self.assertFalse(detector.is_url("/model.hef"))
        self.assertEqual(detector.extract_model_name("/model.hef"), "model.hef")
        self.assertEqual(detector.extract_model_name(url="https://host/m.hef"), "m.hef")
        with self.assertRaises(ValueError):
            detector.download_model("https://host/file.txt", "unused")
        with patch.object(hailo.urllib.request, "urlretrieve") as retrieve:
            detector.download_model("https://host/m.hef", "model.hef")
            retrieve.assert_called_once_with("https://host/m.hef", "model.hef")
        with (
            patch.object(
                hailo.urllib.request, "urlretrieve", side_effect=OSError("offline")
            ),
            self.assertRaises(RuntimeError),
        ):
            detector.download_model("https://host/m.hef", "model.hef")

    def test_detection_filters_scores_pads_and_truncates(self):
        detector = self.detector()
        for count in (0, 2, 20, 25):
            good = np.tile([0.1, 0.2, 0.3, 0.4, 0.9], (count, 1))
            detector.response_store.get.return_value = (
                None,
                [good, np.array([[0, 0, 0, 0, 0.1]]), np.array([[1, 2]]), "bad"],
            )
            result = detector.detect_raw(np.zeros((10, 20, 3), dtype=np.uint8))
            self.assertEqual(result.shape, (20, 6))
            self.assertEqual(np.count_nonzero(result[:, 1]), min(count, 20))
            if count:
                np.testing.assert_allclose(result[0], [0, 0.9, 0.1, 0.2, 0.3, 0.4])
        detector.response_store.get.return_value = (
            None,
            [[np.array([[0, 0, 1, 1, 0.8]])]],
        )
        self.assertAlmostEqual(
            float(detector.detect_raw(np.zeros((10, 20, 3), dtype=np.uint8))[0, 1]), 0.8
        )
        with self.assertRaises(ValueError):
            detector.preprocess("bad")

    def test_timeout_distinguishes_busy_and_dead_worker(self):
        detector = self.detector()
        detector.response_store.get.side_effect = TimeoutError()
        detector.inference_thread.is_alive.return_value = True
        np.testing.assert_array_equal(
            detector.detect_raw(np.zeros((10, 20, 3), dtype=np.uint8)),
            np.zeros((20, 6)),
        )
        detector.inference_thread.is_alive.return_value = False
        with self.assertRaisesRegex(RuntimeError, "restart required"):
            detector.detect_raw(np.zeros((10, 20, 3), dtype=np.uint8))

    def test_detector_initializes_and_closes_sdk(self):
        config = hailo.HailoDetectorConfig(
            type="hailo", model=ModelConfig(path="model.hef")
        )
        with (
            patch.object(hailo.HailoDetector, "activate_dependencies"),
            patch.object(hailo, "detect_hailo_arch", return_value="hailo8"),
            patch.object(
                hailo.HailoDetector, "check_and_prepare", return_value="model.hef"
            ),
            patch.object(hailo, "HailoAsyncInference") as engine,
            patch.object(hailo.threading, "Thread") as thread,
        ):
            engine.return_value.get_input_shape.return_value = (10, 20, 3)
            detector = hailo.HailoDetector(config)
            thread.return_value.start.assert_called_once()
            self.assertEqual(detector.input_shape, (10, 20, 3))
            detector.close()
            engine.return_value.target.release.assert_called_once()
            engine.side_effect = RuntimeError("bad model")
            with self.assertRaisesRegex(RuntimeError, "bad model"):
                hailo.HailoDetector(config)
        detector = self.detector()
        detector.inference_engine = SimpleNamespace()
        detector.close()
