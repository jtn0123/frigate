"""Verify incident timing, recovery and missing-data behavior."""

import tempfile
import unittest
from pathlib import Path

from incidents import Incidents


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.monitor = Incidents(Path(self.tmp.name) / "history.sqlite")
        self.sample = {
            "time": 100,
            "source_updated": 100,
            "detector_ms": {"gpu": 200},
            "cameras": {
                "door": {
                    "enabled": True,
                    "camera_fps": 5,
                    "skipped_fps": 2,
                    "recording_expected": True,
                    "recording_end": 99,
                }
            },
            "containers": {"frigate": {"running": True}},
        }

    def tearDown(self):
        self.monitor.db.close()
        self.tmp.cleanup()

    def test_duplicate_stats_do_not_trigger_false_sustained_alert(self):
        for i in range(5):
            report = self.monitor.observe({**self.sample, "time": 100 + i})
        self.assertEqual(report["incidents"], [])
        for n in (116, 132):
            report = self.monitor.observe(
                {**self.sample, "time": n, "source_updated": n}
            )
        self.assertEqual(
            {r["key"] for r in report["incidents"]}, {"ai:slow", "detection:door"}
        )

    def test_stale_data_does_not_resolve_existing_ai_incident(self):
        for n in (100, 116, 132):
            self.monitor.observe({**self.sample, "time": n, "source_updated": n})
        report = self.monitor.observe({**self.sample, "time": 300})
        self.assertIsNone(
            next(r for r in report["incidents"] if r["key"] == "ai:slow")["resolved"]
        )
        report = self.monitor.observe(
            {
                **self.sample,
                "time": 301,
                "source_updated": 301,
                "detector_ms": {"gpu": 5},
            }
        )
        self.assertEqual(
            next(r for r in report["incidents"] if r["key"] == "ai:slow")["resolved"],
            301,
        )

    def test_recording_failure_independent_from_healthy_capture(self):
        report = self.monitor.observe(
            {**self.sample, "time": 230, "source_updated": 230}
        )
        self.assertIn("recording:door", {r["key"] for r in report["incidents"]})
        self.assertNotIn("capture:door", {r["key"] for r in report["incidents"]})

    def test_history_survives_restart_and_prunes_old_samples(self):
        self.monitor.observe(self.sample)
        self.monitor.db.close()
        self.monitor = Incidents(Path(self.tmp.name) / "history.sqlite")
        self.assertEqual(len(self.monitor.report(101)["samples"]), 1)
        self.monitor.observe({**self.sample, "time": 90000, "source_updated": 90000})
        self.assertEqual(len(self.monitor.report(90000)["samples"]), 1)

    def test_missing_measurements_do_not_resolve_existing_incidents(self):
        for n in (100, 116, 132):
            self.monitor.observe({**self.sample, "time": n, "source_updated": n})
        report = self.monitor.observe({"time": 148, "source_updated": 148})
        active = {r["key"] for r in report["incidents"] if r["resolved"] is None}
        self.assertTrue({"ai:slow", "detection:door", "monitoring:partial"} <= active)

    def test_capture_waits_twenty_seconds_then_requires_valid_recovery(self):
        self.sample["cameras"]["door"]["camera_fps"] = 0
        for n in (100, 115):
            report = self.monitor.observe(
                {**self.sample, "time": n, "source_updated": n}
            )
            self.assertNotIn("capture:door", {r["key"] for r in report["incidents"]})
        report = self.monitor.observe(
            {**self.sample, "time": 130, "source_updated": 130}
        )
        self.assertIn("capture:door", {r["key"] for r in report["incidents"]})
        self.sample["cameras"]["door"]["camera_fps"] = None
        report = self.monitor.observe(
            {**self.sample, "time": 145, "source_updated": 145}
        )
        self.assertIsNone(
            next(r for r in report["incidents"] if r["key"] == "capture:door")[
                "resolved"
            ]
        )

    def test_container_restart_is_retained_after_running_again(self):
        self.sample["containers"]["frigate"]["started"] = "first"
        self.monitor.observe(self.sample)
        self.sample["containers"]["frigate"]["started"] = "second"
        report = self.monitor.observe(
            {**self.sample, "time": 115, "source_updated": 115}
        )
        self.assertIn("restart:frigate", {r["key"] for r in report["incidents"]})
        report = self.monitor.observe(
            {**self.sample, "time": 130, "source_updated": 130}
        )
        self.assertEqual(
            next(r for r in report["incidents"] if r["key"] == "restart:frigate")[
                "resolved"
            ],
            130,
        )

    def test_ollama_parser_handles_compound_durations_without_retaining_logs(self):
        from incident_monitor import completion_timings

        result = completion_timings(
            '[GIN] | 200 | 1m20.5s | private POST "/api/generate"\n[GIN] | 500 | 50µs | secret POST "/api/chat"'
        )
        self.assertEqual(result[0]["duration_seconds"], 80.5)
        self.assertAlmostEqual(result[1]["duration_seconds"], 0.00005)
        self.assertNotIn("private", str(result))
        self.assertNotIn("secret", str(result))

    def test_ollama_unavailable_preserves_camera_sample(self):
        import json
        import subprocess
        from unittest.mock import patch

        from incident_monitor import capture

        with patch(
            "incident_monitor.subprocess.run",
            side_effect=[
                subprocess.CompletedProcess([], 0, json.dumps(self.sample)),
                subprocess.TimeoutExpired("journalctl", 5),
            ],
        ):
            result = capture()
        self.assertEqual(result["cameras"], self.sample["cameras"])
        self.assertIsNone(result["ollama_completions_last_20s"])
