"""Verify optional generation telemetry is private and failure tolerant."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frigate.stats import generation_metrics as metrics


class TestGenerationMetrics(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.override = patch.object(
            metrics, "METRICS_DIRECTORY", Path(self.directory.name)
        )
        self.override.start()
        self.addCleanup(self.override.stop)
        self.provider = SimpleNamespace(base_url="http://private-host", model="model-a")

    def test_records_only_timings_and_converts_nanoseconds(self):
        metrics.record_generation_metrics(
            self.provider,
            {
                "total_duration": 2500000000,
                "load_duration": 0,
                "response": "private speech",
                "prompt": "private image",
            },
            3,
        )
        result = metrics.read_generation_metrics(self.provider)
        self.assertEqual(result["latency_ms"], 2500)
        self.assertEqual(result["load_ms"], 0)
        self.assertEqual(set(result), {"latency_ms", "load_ms", "last_used"})
        self.assertNotIn("private", metrics.metrics_path(self.provider).read_text())
        other = SimpleNamespace(base_url="http://other", model="model-a")
        self.assertEqual(metrics.read_generation_metrics(other), {})

    def test_invalid_metadata_uses_elapsed_time(self):
        metrics.record_generation_metrics(
            self.provider,
            {
                "total_duration": float("nan"),
                "load_duration": -1,
            },
            1.5,
        )
        result = metrics.read_generation_metrics(self.provider)
        self.assertEqual(result["latency_ms"], 1500)
        self.assertIsNone(result["load_ms"])
        self.assertIsNone(metrics.finite(True))

    def test_write_failure_does_not_break_generation(self):
        with patch.object(metrics.os, "replace", side_effect=OSError):
            metrics.record_generation_metrics(self.provider, {}, 1)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_rejects_malformed_and_oversized_files(self):
        path = metrics.metrics_path(self.provider)
        for value in ["not json", "[]", "x" * 4097]:
            path.write_text(value)
            self.assertEqual(metrics.read_generation_metrics(self.provider), {})
        path.write_text(json.dumps({"latency_ms": "bad", "response": "private"}))
        self.assertIsNone(metrics.read_generation_metrics(self.provider)["latency_ms"])
