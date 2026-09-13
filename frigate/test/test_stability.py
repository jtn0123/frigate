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

            def fail_request():
                with generation_requests.generation_request(8):
                    raise ValueError("private prompt")

            with self.assertRaises(ValueError):
                fail_request()
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

    def test_missing_malformed_and_oversized_snapshots_are_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stability.json"
            with patch.object(stability, "PATH", path):
                self.assertEqual(stability.read_stability()["status"], "not_connected")
                for content in ("bad json", "[]", "x" * (2 * 1024 * 1024 + 1)):
                    with self.subTest(size=len(content)):
                        path.write_text(content)
                        self.assertEqual(
                            stability.read_stability()["status"], "invalid"
                        )

    def test_fresh_snapshot_filters_unknown_incidents_and_private_failure_text(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stability.json"
            path.write_text(
                json.dumps(
                    {
                        "updated": 100,
                        "incidents": [
                            {"key": "private:secret"},
                            {"key": "server:ollama", "started": 90},
                        ],
                        "samples": [
                            {
                                "time": 100,
                                "cameras": {"door": {"skipped_fps": 0}},
                                "ollama_completions_last_20s": [],
                                "audio_failure": {
                                    "updated": 95,
                                    "stage": "private",
                                    "cause": "secret",
                                },
                            }
                        ],
                    }
                )
            )
            with (
                patch.object(stability, "PATH", path),
                patch.object(stability.time, "time", return_value=101),
            ):
                result = stability.read_stability()
            self.assertEqual(result["status"], "connected")
            self.assertEqual(len(result["incidents"]), 1)
            self.assertEqual(result["audio_failure"]["stage"], "unknown")
            self.assertEqual(result["audio_failure"]["cause"], "unknown")
            self.assertNotIn("secret", json.dumps(result))

    def test_successful_request_records_running_then_complete_and_prunes_old_data(self):
        import os

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(generation_requests, "DIRECTORY", Path(directory)),
        ):
            old = Path(directory) / "old.json"
            old.write_text("{}")
            os.utime(old, (1, 1))
            with generation_requests.generation_request(1):
                self.assertFalse(old.exists())
                data = json.loads(next(Path(directory).glob("*.json")).read_text())
                self.assertEqual(data["status"], "running")
                self.assertIsNone(data["ended"])
            data = json.loads(next(Path(directory).glob("*.json")).read_text())
            self.assertEqual(data["status"], "complete")
            self.assertEqual(data["images"], 1)

    def test_telemetry_filesystem_failure_does_not_fail_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            blocked = Path(directory) / "file"
            blocked.write_text("existing")
            with patch.object(generation_requests, "DIRECTORY", blocked):
                with generation_requests.generation_request(1):
                    result = "generated"
            self.assertEqual(result, "generated")
            self.assertEqual(blocked.read_text(), "existing")
