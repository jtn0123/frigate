"""Test private-content boundaries and truthful incident status."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frigate.stats import generation_requests, stability


class StabilityTests(unittest.TestCase):
    def test_stale_snapshot_keeps_history_but_does_not_claim_current_health(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stability.json"
            path.write_text(
                json.dumps(
                    {
                        "updated": 100,
                        "incidents": [
                            {
                                "key": "recording:door",
                                "started": 90,
                                "private": "secret",
                            }
                        ],
                        "samples": [
                            {
                                "time": 100,
                                "detector_ms": {"gpu": 5},
                                "prompt": "private",
                            }
                        ],
                    }
                )
            )
            with (
                patch.object(stability, "PATH", path),
                patch.object(stability.time, "time", return_value=200),
            ):
                result = stability.read_stability()
            self.assertEqual(result["status"], "stale")
            self.assertEqual(result["incidents"][0]["kind"], "recording")
            self.assertNotIn("private", json.dumps(result))
            self.assertNotIn("secret", json.dumps(result))

    def test_request_lifecycle_survives_failure_without_private_exception(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(generation_requests, "DIRECTORY", Path(directory)),
        ):
            with self.assertRaises(ValueError):
                with generation_requests.generation_request(8):
                    running = json.loads(
                        next(Path(directory).glob("*.json")).read_text()
                    )
                    self.assertEqual(running["status"], "running")
                    self.assertIsNone(running["ended"])
                    raise ValueError("private prompt")
            finished = json.loads(next(Path(directory).glob("*.json")).read_text())
            self.assertEqual(finished["status"], "failed")
            self.assertGreaterEqual(finished["ended"], finished["started"])
            self.assertNotIn("private", json.dumps(finished))

    def test_missing_values_remain_unmeasured(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stability.json"
            path.write_text(
                json.dumps(
                    {
                        "updated": 100,
                        "samples": [
                            {
                                "time": 100,
                                "cameras": {"door": {"skipped_fps": None}},
                                "ollama_completions_last_20s": None,
                            }
                        ],
                    }
                )
            )
            with patch.object(stability, "PATH", path):
                result = stability.read_stability()
            self.assertIsNone(result["samples"][0]["skipped_fps"])
            self.assertIsNone(result["samples"][0]["ollama_requests"])
