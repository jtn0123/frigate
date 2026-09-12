"""Verify metrics publish without private event data or stale live allocations."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import telemetry


class TelemetryTests(unittest.TestCase):
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
