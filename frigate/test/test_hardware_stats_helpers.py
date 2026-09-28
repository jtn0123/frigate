"""Tests for the hardware stats helpers split out of the scanners and poller."""

from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import patch

from frigate.stats import hardware
from frigate.stats.hardware import (
    HardwarePollResult,
    HardwareStats,
    _detector_hardware,
    _openvino_hardware,
    _vaapi_hardware,
)
from frigate.test.test_hardware_stats import HardwareStatsTestCase


def finished(result=None, error: Exception | None = None) -> Future:
    future: Future = Future()
    if error is not None:
        future.set_exception(error)
    else:
        future.set_result(result)
    return future


class TestHardwareMapping(HardwareStatsTestCase):
    def test_vaapi_follows_the_loaded_driver(self):
        with patch.object(hardware, "_is_amd_vaapi", return_value=True):
            self.assertEqual(_vaapi_hardware(), "amd_gpu")

        with patch.object(hardware, "_is_amd_vaapi", return_value=False):
            self.assertEqual(_vaapi_hardware(), "intel_gpu")

    def test_openvino_devices(self):
        self.assertEqual(_openvino_hardware("NPU"), "intel_npu")
        self.assertEqual(_openvino_hardware(None), "intel_gpu")
        self.assertEqual(_openvino_hardware("GPU.1"), "intel_gpu")
        self.assertIsNone(_openvino_hardware("CPU"))

    def test_detector_types(self):
        self.assertEqual(_detector_hardware("rknn", None), "rockchip")
        self.assertEqual(_detector_hardware("axengine", None), "axengine")
        self.assertEqual(_detector_hardware("tensorrt", "0"), "jetson")
        self.assertEqual(_detector_hardware("openvino", "NPU"), "intel_npu")
        self.assertIsNone(_detector_hardware("edgetpu", "usb"))

        with patch.object(hardware, "_present_gpu", return_value="amd_gpu"):
            self.assertEqual(_detector_hardware("onnx", None), "amd_gpu")


class TestScanFfmpegInputs(HardwareStatsTestCase):
    def test_list_args_and_duplicates_are_scanned_once(self):
        stats = self.make_stats()
        stats.config = SimpleNamespace(
            cameras={
                "a": SimpleNamespace(
                    ffmpeg=SimpleNamespace(
                        hwaccel_args=["-hwaccel", "qsv"],
                        inputs=[
                            SimpleNamespace(hwaccel_args="-hwaccel qsv"),
                            SimpleNamespace(hwaccel_args=["-c:v", "h264_cuvid"]),
                            SimpleNamespace(hwaccel_args=""),
                        ],
                    )
                )
            }
        )

        with patch.object(
            hardware, "_hwaccel_hardware", wraps=hardware._hwaccel_hardware
        ) as mapped:
            self.assertEqual(stats._scan_ffmpeg(), {"intel_gpu", "nvidia"})

        self.assertEqual(
            [call.args[0] for call in mapped.call_args_list],
            ["-hwaccel qsv", "-c:v h264_cuvid"],
        )


class TestSemanticSearchUsesGpu(HardwareStatsTestCase):
    def uses_gpu(self, **semantic) -> bool:
        stats = self.make_stats()
        defaults = {"enabled": True, "model": None, "model_size": "large"}
        stats.config = SimpleNamespace(
            semantic_search=SimpleNamespace(**{"device": None, **defaults, **semantic})
        )
        return stats._semantic_search_uses_gpu()

    def test_disabled_uses_no_gpu(self):
        self.assertFalse(self.uses_gpu(enabled=False))

    def test_a_genai_provider_runs_remotely(self):
        self.assertFalse(self.uses_gpu(model="my_openai_provider"))

    def test_the_model_size_picks_the_default_device(self):
        self.assertTrue(self.uses_gpu())
        self.assertTrue(self.uses_gpu(model=hardware.SemanticSearchModelEnum.jinav2))
        self.assertFalse(self.uses_gpu(model_size="small"))
        self.assertTrue(self.uses_gpu(model_size="small", device="GPU"))


class TestCollectResults(HardwareStatsTestCase):
    def test_timeouts_and_failures_latch_an_error(self):
        stats = self.make_stats()
        good = finished(HardwarePollResult(gpu={"a": {"gpu": "1%"}}, npu={"n": {}}))
        not_ok = finished(HardwarePollResult(gpu={"b": {"gpu": ""}}, ok=False))
        raised = finished(error=RuntimeError("boom"))
        pending: Future = Future()
        futures = {good: "nvidia", not_ok: "intel_gpu", raised: "rpi", pending: "jet"}

        with self.assertLogs(hardware.logger, "WARNING"):
            gpu, npu = stats._collect_hardware_results(futures, {good, not_ok, raised})

        self.assertEqual(gpu, {"a": {"gpu": "1%"}, "b": {"gpu": ""}})
        self.assertEqual(npu, {"n": {}})
        self.assertEqual(set(stats._errors), {"intel_gpu", "rpi", "jet"})

    def test_cpu_stats_are_filled_only_when_present(self):
        all_stats: dict = {}
        HardwareStats._collect_cpu_result(finished({}), all_stats)
        self.assertNotIn("cpu_usages", all_stats)

        HardwareStats._collect_cpu_result(finished({"1": {"cpu": "2"}}), all_stats)
        self.assertEqual(all_stats["cpu_usages"], {"1": {"cpu": "2"}})

    def test_a_failed_cpu_poll_is_logged_and_skipped(self):
        all_stats: dict = {}

        with self.assertLogs(hardware.logger, "ERROR"):
            HardwareStats._collect_cpu_result(
                finished(error=OSError("proc")), all_stats
            )

        self.assertEqual(all_stats, {})

    def test_update_stats_fills_cpu_usages(self):
        stats = self.make_stats()

        with patch.object(hardware, "get_cpu_stats", return_value={"1": {}}):
            all_stats: dict = {}
            stats.update_stats(all_stats)

        self.assertEqual(all_stats, {"cpu_usages": {"1": {}}})
