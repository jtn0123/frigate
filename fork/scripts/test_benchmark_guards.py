"""The benchmark scripts accept only the values their workflows pass to docker."""

import argparse
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
WORKFLOWS = HERE.parents[1] / ".github/workflows"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_measured(
    arguments: list[str], env: dict[str, str], directory: str
) -> subprocess.CompletedProcess:
    """Run a python script, folding its coverage into the current measurement.

    Under the CI coverage run the child writes its own data file, which is then
    merged into the parent's data so the script counts as covered.
    """
    command = [sys.executable]
    if os.environ.get("COVERAGE_RUN"):
        child_data = Path(directory) / "child.coverage"
        command += ["-m", "coverage", "run"]
        env = env | {"COVERAGE_FILE": str(child_data)}
    result = subprocess.run(
        command + arguments, env=env, capture_output=True, text=True
    )
    if os.environ.get("COVERAGE_RUN"):
        import coverage

        data = coverage.CoverageData(str(child_data))
        data.read()
        coverage.Coverage.current().get_data().update(data)
    return result


benchmark_image_build = load("benchmark_image_build")
dependency_images = load("dependency_images")


class TestBuildKitImagePin(unittest.TestCase):
    def test_pin_matches_the_benchmark_workflows(self):
        for workflow in ("fork-build-benchmark.yml", "fork-concurrency-benchmark.yml"):
            text = (WORKFLOWS / workflow).read_text()
            pinned = re.search(r"^\s*BUILDKIT_IMAGE:\s*(\S+)", text, re.MULTILINE)
            self.assertIsNotNone(pinned, workflow)
            self.assertEqual(
                pinned.group(1), benchmark_image_build.PINNED_BUILDKIT_IMAGE
            )

    def test_another_buildkit_image_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "benchmark_image_build.py",
                "--source",
                directory,
                "--output",
                directory,
                "--case",
                "baseline",
                "--context",
                "colima-frigate-build-bench",
                "--buildkit-image",
                "moby/buildkit:latest",
            ]
            with patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as exit:
                benchmark_image_build.main()
        self.assertEqual(exit.exception.code, 2)


class TestPinnedArguments(unittest.TestCase):
    def pin(self, **overrides):
        values = {
            "context": "colima-frigate-build-bench",
            "registry": "localhost:5007",
            "case": "shared-zstd",
            "buildkit_image": None,
        } | overrides
        args = argparse.Namespace(**values)
        benchmark_image_build.pin_arguments(argparse.ArgumentParser(), args)
        return args

    def test_accepted_values_are_replaced_by_the_constants(self):
        # Copies built at run time, so identity proves the constant was used.
        image = "".join(list(benchmark_image_build.PINNED_BUILDKIT_IMAGE))
        args = self.pin(buildkit_image=image, case="".join(list("shared-zstd")))
        self.assertIs(args.buildkit_image, benchmark_image_build.PINNED_BUILDKIT_IMAGE)
        self.assertIs(args.context, benchmark_image_build.KNOWN_CONTEXTS[0])
        self.assertIs(args.case, benchmark_image_build.KNOWN_CASES[2])
        self.assertIs(args.registry, benchmark_image_build.BENCHMARK_REGISTRY)

    def test_no_buildkit_image_stays_unset(self):
        self.assertIsNone(self.pin().buildkit_image)

    def test_other_context_or_registry_is_refused(self):
        for overrides in ({"context": "default"}, {"registry": "ghcr.io"}):
            with self.assertRaises(SystemExit):
                self.pin(**overrides)


class TestDependencyImagesContext(unittest.TestCase):
    def test_unknown_context_is_refused_before_docker_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "dependency_images.py",
                "--repository",
                "example.invalid/image",
                "--cache",
                "example.invalid/cache",
                "--amd64-tags",
                "a",
                "--rocm-tags",
                "b",
                "--output",
                directory,
                "--context",
                "default",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(dependency_images.subprocess, "run") as run,
                self.assertRaises(SystemExit) as exit,
            ):
                dependency_images.main()
        self.assertEqual(exit.exception.code, 2)
        run.assert_not_called()

    def test_known_context_reaches_docker_as_the_constant(self):
        class Reached(Exception):
            pass

        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "dependency_images.py",
                "--repository",
                "example.invalid/image",
                "--cache",
                "example.invalid/cache",
                "--amd64-tags",
                "a",
                "--rocm-tags",
                "b",
                "--output",
                directory,
                "--context",
                "".join(list("frigate-github-bench")),
            ]
            with (
                patch.object(sys, "argv", argv),
                # The thin test image has no docker or web directory to hash.
                patch.object(dependency_images, "dependency_key", return_value="key"),
                patch.object(dependency_images, "web_key", return_value="key"),
                patch.object(
                    dependency_images.subprocess, "run", side_effect=Reached
                ) as run,
                patch.object(
                    dependency_images.subprocess, "check_output", side_effect=Reached
                ) as check_output,
                self.assertRaises(Reached),
            ):
                dependency_images.main()
        command = (run.call_args or check_output.call_args).args[0]
        self.assertEqual(command[:2], ["docker", "--context"])
        self.assertIs(command[2], dependency_images.KNOWN_CONTEXTS[1])

    def test_known_contexts_are_the_workflow_ones(self):
        for context in dependency_images.KNOWN_CONTEXTS:
            self.assertRegex(context, r"^[a-z][a-z0-9-]+$")


class TestBenchmarkSmoke(unittest.TestCase):
    def test_unknown_case_exits_before_docker_runs(self):
        # The script guards on the runner environment at import, so it is run
        # as a process with that environment faked and PATH emptied: reaching
        # docker would fail differently from the case check.
        env = os.environ | {
            "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted",
            "PATH": "",
        }
        with tempfile.TemporaryDirectory() as directory:
            result = run_measured(
                [str(HERE / "benchmark_smoke.py"), directory, "nope"], env, directory
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown benchmark case: nope", result.stderr)


if __name__ == "__main__":
    unittest.main()
