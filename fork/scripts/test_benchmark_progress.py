"""Regression checks for durable benchmark measurements and honest comparisons."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "benchmark", Path(__file__).with_name("benchmark_image_build.py")
)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class TestBenchmarkProgress(unittest.TestCase):
    def test_success_is_saved_before_caller_cleanup_can_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "build.log"
            seconds = benchmark.measure(
                [sys.executable, "-c", "print('ok')"], directory, log
            )
            saved = json.loads(log.with_suffix(".timing.json").read_text())
            self.assertEqual(saved["status"], "success")
            self.assertEqual(saved["seconds"], seconds)
            self.assertGreater(seconds, 0)

    def test_failed_command_preserves_timing_and_log(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "build.log"
            with self.assertRaises(RuntimeError):
                benchmark.measure(
                    [sys.executable, "-c", "print('failed'); exit(3)"], directory, log
                )
            saved = json.loads(log.with_suffix(".timing.json").read_text())
            self.assertEqual(saved["returncode"], 3)
            self.assertEqual(saved["status"], "failed")
            self.assertIn("failed", log.read_text())

    def test_percentage_uses_elapsed_time_reduction(self):
        self.assertEqual(benchmark.time_reduction(100, 75), 25)
        self.assertEqual(benchmark.time_reduction(100, 125), -25)
        self.assertIsNone(benchmark.time_reduction(0, 10))

    def test_milestones_require_completed_final_image_export(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "build.log"
            log.write_text(
                "#1 [amd64] exporting to image\n#1 DONE 5.0s\n#2 [rocm] exporting to image\n"
            )
            self.assertEqual(benchmark.completed_milestones(log), {"amd64-image"})
            log.write_text(log.read_text() + "#2 DONE 8.0s\n")
            self.assertEqual(
                benchmark.completed_milestones(log), {"amd64-image", "rocm-image"}
            )
