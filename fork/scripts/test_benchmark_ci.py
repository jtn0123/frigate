"""Check benchmark CI reports and reject invalid comparison evidence."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "benchmark_ci", Path(__file__).with_name("benchmark_ci.py")
)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class TestBenchmarkCi(unittest.TestCase):
    def test_prepare_records_frozen_sources_and_runner_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "measurement"
            calls = []

            def run(*command):
                calls.append(command)
                if command[:2] == ("git", "archive"):
                    Path(command[3]).write_bytes(b"archive")
                elif command[:2] == ("tar", "-xf"):
                    (Path(command[4]) / "frigate").mkdir()
                elif command[:2] == ("docker", "info"):
                    return "{}"
                elif command[:3] == ("git", "rev-parse", "HEAD"):
                    return "candidate\n"
                return "fixture"

            original_read_text = Path.read_text

            def read_text(path, *args, **kwargs):
                if str(path) == "/proc/meminfo":
                    return "MemTotal: fixture"
                return original_read_text(path, *args, **kwargs)

            with (
                patch.object(benchmark, "run", side_effect=run),
                patch.object(
                    benchmark.shutil,
                    "disk_usage",
                    return_value=SimpleNamespace(free=70 * 1024**3),
                ),
                patch.object(Path, "read_text", read_text),
                patch.dict(os.environ, {"MAX_PARALLELISM": "4"}),
            ):
                benchmark.prepare(root)
            report = json.loads((root / "environment.json").read_text())
            self.assertEqual(report["limits"]["parallelism"], 4)
            self.assertEqual(report["candidate_commit"], "candidate")
            self.assertEqual(report["baseline_commit"], benchmark.BASELINE)
            for name in ("before", "after"):
                self.assertEqual(
                    (root / name / "frigate/version.py").read_text(),
                    'VERSION = "0.18.0-build-benchmark"\n',
                )
                self.assertFalse((root / f"{name}.tar").exists())
            self.assertIn(("docker", "pull", benchmark.BUILDKIT), calls)

    def test_prepare_refuses_low_docker_storage_before_creating_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "measurement"
            with (
                patch.object(
                    benchmark.shutil,
                    "disk_usage",
                    return_value=SimpleNamespace(free=64 * 1024**3),
                ),
                patch.object(benchmark, "run") as run,
                self.assertRaisesRegex(RuntimeError, "65 GiB"),
            ):
                benchmark.prepare(root)
            run.assert_not_called()

    def test_summary_only_calculates_delta_for_two_successful_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for case in ("shared-zstd", "dependency-images"):
                (root / case).mkdir()
            (root / "shared-zstd/cold-benchmark.timing.json").write_text(
                json.dumps({"status": "success", "seconds": 120})
            )
            (root / "dependency-images/cold-benchmark.timing.json").write_text(
                json.dumps({"status": "success", "seconds": 90})
            )
            (root / "shared-zstd/app-change-benchmark.timing.json").write_text(
                json.dumps({"status": "failed", "seconds": 60})
            )
            (root / "dependency-images/app-change-benchmark.timing.json").write_text(
                json.dumps({"status": "success", "seconds": 40})
            )
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}):
                benchmark.summary(root)
            report = (root / "summary.md").read_text()
            self.assertIn(
                "| cold | 2.00 min (success) | 1.50 min (success) | 25.00% |", report
            )
            self.assertIn(
                "| app-change | 1.00 min (failed) | 0.67 min (success) | Pending |",
                report,
            )

    def test_validate_accepts_equivalent_images_and_records_gpu_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for case in ("shared-zstd", "dependency-images"):
                folder = root / case
                folder.mkdir()
                for arch in ("amd64", "rocm"):
                    (folder / f"{arch}-smoke.log").write_text(
                        json.dumps({"app_hashes": {"app": "same"}}) + "\n"
                    )
                    (folder / f"{arch}-config.json").write_text(
                        json.dumps(
                            {"Architecture": "amd64", "Os": "linux", "Config": {}}
                        )
                    )
            benchmark.validate(root)
            self.assertEqual(
                json.loads((root / "validation.json").read_text()),
                {"equivalence": "passed", "gpu_execution": "not tested"},
            )
            (root / "dependency-images/rocm-config.json").write_text(
                json.dumps(
                    {"Architecture": "amd64", "Os": "linux", "Config": {"User": "root"}}
                )
            )
            with self.assertRaisesRegex(RuntimeError, "configuration differ"):
                benchmark.validate(root)

    def test_validate_rejects_different_resolved_base_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for case in ("shared-zstd", "dependency-images"):
                folder = root / case
                folder.mkdir()
                for arch in ("amd64", "rocm"):
                    (folder / f"{arch}-smoke.log").write_text(
                        json.dumps({"app_hashes": {"app": "same"}}) + "\n"
                    )
                    (folder / f"{arch}-config.json").write_text(
                        json.dumps(
                            {"Architecture": "amd64", "Os": "linux", "Config": {}}
                        )
                    )
                digest = "a" if case == "shared-zstd" else "b"
                (folder / "build.log").write_text(
                    "docker.io/library/debian@sha256:" + digest * 64 + "\n"
                )
            with self.assertRaisesRegex(RuntimeError, "base images differ"):
                benchmark.validate(root)

    def test_registry_resets_only_the_named_disposable_registry(self):
        with patch.object(benchmark, "run", return_value="") as run:
            benchmark.registry(reset=True)
        self.assertEqual(
            [call.args for call in run.call_args_list[:2]],
            [
                ("docker", "rm", "-f", "frigate-bench-registry"),
                ("docker", "volume", "rm", "frigate-bench-registry"),
            ],
        )
        self.assertEqual(run.call_args.args[-1], "registry:2")

    def test_main_requires_hosted_runner_and_confined_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root.parent / "outside-benchmark"
            with patch.object(sys, "argv", ["benchmark_ci.py", "summary", str(root)]):
                with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}):
                    with self.assertRaises(SystemExit) as error:
                        benchmark.main()
                self.assertEqual(error.exception.code, 2)
            env = {
                "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_TEMP": str(root),
            }
            with patch.dict(os.environ, env):
                with patch.object(
                    sys, "argv", ["benchmark_ci.py", "summary", str(outside)]
                ):
                    with self.assertRaises(SystemExit) as error:
                        benchmark.main()
                self.assertEqual(error.exception.code, 2)
                with patch.object(
                    sys, "argv", ["benchmark_ci.py", "summary", str(root)]
                ):
                    with patch.object(benchmark, "summary") as summary:
                        benchmark.main()
                    summary.assert_called_once_with(root.resolve())


if __name__ == "__main__":
    unittest.main()
