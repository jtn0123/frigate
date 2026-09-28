"""Regression checks for durable benchmark measurements and honest comparisons."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "benchmark", Path(__file__).with_name("benchmark_image_build.py")
)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class TestBenchmarkProgress(unittest.TestCase):
    def test_app_change_records_shared_build_and_removes_source_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            output = root / "output"
            (source / "frigate").mkdir(parents=True)
            argv = [
                "benchmark_image_build.py",
                "--source",
                str(source),
                "--output",
                str(output),
                "--case",
                "shared-zstd",
                "--phase",
                "app-change",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(
                    benchmark, "build_targets", return_value={"benchmark": 12.5}
                ) as build,
                patch.object(
                    benchmark, "summarize_log", return_value={"operations": []}
                ),
            ):
                benchmark.main()
            result = json.loads((output / "results.json").read_text())
            self.assertEqual(result["phases"]["app-change"]["seconds"], 12.5)
            self.assertEqual(
                result["phases"]["app-change"]["targets"], {"benchmark": 12.5}
            )
            self.assertFalse((source / "frigate/build_benchmark_marker.txt").exists())
            self.assertEqual(build.call_args.args[-1], ["benchmark"])
            override = json.loads((output / "app-change.json").read_text())
            self.assertIn(
                "compression=zstd", override["target"]["amd64"]["cache-to"][0]
            )

    def test_failed_build_removes_source_marker_without_writing_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "frigate").mkdir(parents=True)
            output = root / "output"
            argv = [
                "benchmark_image_build.py",
                "--source",
                str(source),
                "--output",
                str(output),
                "--case",
                "baseline",
                "--phase",
                "app-change",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(
                    benchmark, "build_targets", side_effect=RuntimeError("build failed")
                ),
                self.assertRaisesRegex(RuntimeError, "build failed"),
            ):
                benchmark.main()
            self.assertFalse((source / "frigate/build_benchmark_marker.txt").exists())
            self.assertFalse((output / "results.json").exists())

    def test_rejects_mutable_seed_cache_before_touching_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seeds = root / "seeds.json"
            seeds.write_text(json.dumps(["ghcr.io/frigate:latest"]))
            argv = [
                "benchmark_image_build.py",
                "--source",
                str(root),
                "--output",
                str(root / "output"),
                "--case",
                "shared-zstd",
                "--seed-caches",
                str(seeds),
            ]
            with (
                patch.object(sys, "argv", argv),
                self.assertRaises(SystemExit) as error,
            ):
                benchmark.main()
            self.assertEqual(error.exception.code, 2)
            self.assertFalse((root / "output").exists())

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

    def test_disk_guard_allows_log_partition_with_four_gib_free(self):
        benchmark.check_disk_reserve(4 * 1024**3, 70 * 1024**3)

    def test_disk_guard_stops_before_log_partition_fills(self):
        with self.assertRaisesRegex(RuntimeError, "log partition"):
            benchmark.check_disk_reserve(1 * 1024**3, 70 * 1024**3)

    def test_disk_guard_stops_before_docker_partition_fills(self):
        with self.assertRaisesRegex(RuntimeError, "Docker partition"):
            benchmark.check_disk_reserve(8 * 1024**3, 4 * 1024**3)
