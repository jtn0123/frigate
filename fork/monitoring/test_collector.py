"""Check effective limits without a live Proxmox host or elevated privileges."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import collect_proxmox as collector


class CollectorTests(unittest.TestCase):
    def test_container_id_rejects_options_and_paths_before_spawning(self):
        with patch.object(collector.subprocess, "check_output") as command:
            for value in ("--help", "../106", "106;id", "0"):
                with self.assertRaises(ValueError):
                    collector.init_pid(value)
            command.assert_not_called()

    def test_ollama_measurements_include_only_matching_container_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            group = root / "group"
            for pid, name in (("110", "ollama"), ("111", "ffmpeg")):
                proc = root / pid
                proc.mkdir()
                (proc / "comm").write_text(name)
                fields = ["0"] * 22
                fields[11], fields[12], fields[21] = "100", "50", "2"
                (proc / "stat").write_text(f"{pid} ({name}) " + " ".join(fields))
            cpu_calls = []

            def cpu(key, seconds):
                cpu_calls.append((key, seconds))
                return 12.5

            with (
                patch.object(collector, "Path", return_value=root),
                patch.object(collector, "group_for", return_value=group),
            ):
                rows = collector.collect_ollama(group, "108", cpu, 100)
            self.assertEqual(cpu_calls, [("ollama:108", 1.5)])
            self.assertEqual(rows[0]["cpu_percent"], 12.5)
            self.assertGreater(rows[0]["memory_bytes"], 0)

    def test_ancestor_quota_constrains_unlimited_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "ct" / "docker"
            child.mkdir(parents=True)
            (root / "memory.max").write_text("21474836480")
            (root / "cpu.max").write_text("400000 100000")
            (root / "cpuset.cpus.effective").write_text("0-7")
            (child / "memory.max").write_text("max")
            (child / "cpu.max").write_text("max 100000")
            with patch.object(collector, "CGROUP", root):
                self.assertEqual(collector.effective_limits(child), (21474836480, 4))

    def test_missing_pressure_and_unlimited_are_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pressure"
            self.assertIsNone(collector.pressure(path))
            path.write_text("some avg10=1.20 avg60=0.50 avg300=0.10 total=123\n")
            self.assertEqual(collector.pressure(path), 1.2)
            path.write_text("max")
            self.assertIsNone(collector.limit(path))

    def test_snapshot_does_not_follow_container_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "opt/frigate/config/model_cache"
            target.mkdir(parents=True)
            outside = root / "outside"
            outside.write_text("untouched")
            (target / "server-telemetry.json").symlink_to(outside)
            collector.publish_snapshot(root, {"updated": 1})
            self.assertEqual(outside.read_text(), "untouched")
            self.assertFalse((target / "server-telemetry.json").is_symlink())
            (target / "server-telemetry.json").unlink()
            target.rmdir()
            target.symlink_to(root)
            with self.assertRaises(OSError):
                collector.publish_snapshot(root, {"updated": 2})
