"""Test collector isolation, shutdown and safe operational error paths."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import incident_monitor


class MonitorTests(unittest.TestCase):
    def test_invalid_duration_or_route_is_not_a_completion(self):
        for duration in ("", "secret", "1mBAD", "9" * 65):
            self.assertIsNone(incident_monitor.duration_seconds(duration))
        for line in (
            "private log",
            '[GIN] | 200 | 1s | client | GET "/api/generate"',
            '[GIN] | 200 | bad | client | POST "/api/chat"',
            '[GIN] | 200 | 1s | client | POST "/private"',
        ):
            self.assertEqual(incident_monitor.completion_timings(line), [])

    def test_unknown_ollama_state_keeps_frigate_readings(self):
        source = {"time": 100, "containers": {"frigate": {"running": True}}}
        with patch.object(
            incident_monitor.subprocess,
            "run",
            side_effect=[
                subprocess.CompletedProcess([], 0, json.dumps(source)),
                subprocess.CompletedProcess([], 0, ""),
                subprocess.TimeoutExpired("systemctl", 5),
            ],
        ):
            result = incident_monitor.capture()
        self.assertTrue(result["containers"]["frigate"]["running"])
        self.assertIsNone(result["containers"]["ollama"]["running"])

    def test_daemon_persists_open_recovery_and_outage_then_closes_database(self):
        sample = {
            "time": 100,
            "source_updated": 100,
            "detector_ms": {"gpu": 5},
            "cameras": {"door": {"enabled": True, "camera_fps": 5, "skipped_fps": 0}},
            "containers": {"frigate": {"running": False}},
        }
        recovered = {
            **sample,
            "time": 115,
            "source_updated": 115,
            "containers": {"frigate": {"running": True}},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def resolve_path(path):
                return root if path == "/var/lib/frigate-incidents" else Path(path)

            with (
                patch.object(incident_monitor, "Path", side_effect=resolve_path),
                patch.object(incident_monitor.signal, "signal"),
                patch.object(incident_monitor, "init_pid", return_value=123),
                patch.object(
                    incident_monitor,
                    "capture",
                    side_effect=[sample, recovered, OSError("private")],
                ),
                patch.object(
                    incident_monitor,
                    "publish_snapshot",
                    side_effect=[OSError("private"), None, None],
                ) as publish,
                patch.object(incident_monitor, "STOP") as stop,
                patch.object(incident_monitor.time, "time", return_value=130),
                self.assertLogs(incident_monitor.logger, level="INFO") as logs,
            ):
                stop.is_set.side_effect = [False, False, False, True]
                incident_monitor.main()
            self.assertEqual(publish.call_count, 3)
            self.assertNotIn("private", str(logs.output))
            self.assertTrue(any("opened: server:frigate" in row for row in logs.output))
            self.assertTrue(
                any("resolved: server:frigate" in row for row in logs.output)
            )
            import sqlite3

            with sqlite3.connect(root / "history.sqlite") as db:
                self.assertEqual(
                    db.execute("select count(*) from samples").fetchone()[0], 3
                )
