"""Verify metrics publish without private event data or stale live allocations."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import telemetry


class TelemetryTests(unittest.TestCase):
    def test_unwritable_metrics_do_not_interrupt_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            metrics = telemetry.Telemetry(Path(directory))
            with patch.object(
                telemetry, "atomic_json", side_effect=OSError("disk full")
            ):
                completed = Mock()
                with telemetry.Stage("medium"):
                    completed()
                metrics.sample()
            completed.assert_called_once()

    def test_metrics_failure_preserves_original_inference_exception(self):
        stage = telemetry.Stage("medium")
        failure = RuntimeError("inference failed")
        with patch.object(telemetry, "atomic_json", side_effect=PermissionError()):
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                with stage:
                    raise failure

    def test_malformed_stage_snapshot_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / "stages.json"
            for content in ('{"models": []}', "[]", "{broken"):
                stage.write_text(content)
                with patch.object(telemetry, "STAGE_FILE", stage):
                    metrics = telemetry.Telemetry(root)
                    with telemetry.Stage("medium"):
                        metrics.sample()

    def test_old_process_stage_is_not_attributed_to_new_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / "stages.json"
            stage.write_text(
                json.dumps({"pid": 11, "active": "medium", "models": {"medium": {}}})
            )
            with (
                patch.object(telemetry, "STAGE_FILE", stage),
                patch.object(telemetry, "MODEL_ROOTS", {}),
            ):
                metrics = telemetry.Telemetry(root)
                metrics.sample(12)
                self.assertIsNone(metrics.models["medium"]["ram_bytes"])
                self.assertEqual(metrics.models["medium"]["status"], "unknown")

    def test_stage_and_worker_capture_timings_and_release_current_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / "stages.json"
            model = root / "model.bin"
            model.write_bytes(b"model")
            process = Mock(pid=12)
            process.memory_info.return_value.rss = 12345
            process.cpu_percent.return_value = 150
            with (
                patch.object(telemetry, "STAGE_FILE", stage),
                patch.object(telemetry.os, "getpid", return_value=12),
                patch.object(telemetry, "MODEL_ROOTS", {"medium": root}),
                patch.object(telemetry.psutil, "Process", return_value=process),
            ):
                metrics = telemetry.Telemetry(root)
                with telemetry.Stage("medium"):
                    metrics.sample(12)
                    live = json.loads(metrics.path.read_text())
                    self.assertEqual(live["models"]["medium"]["ram_bytes"], 12345)
                    self.assertEqual(live["models"]["medium"]["status"], "busy")
                metrics.sample()
                result = json.loads(metrics.path.read_text())
                self.assertEqual(result["models"]["medium"]["ram_bytes"], 0)
                self.assertEqual(result["models"]["medium"]["cpu_percent"], 0)
                self.assertGreaterEqual(result["models"]["medium"]["latency_ms"], 0)
                self.assertEqual(result["models"]["medium"]["peak_ram_bytes"], 12345)


if __name__ == "__main__":
    unittest.main()
