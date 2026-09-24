"""Check that the graph smoke probe detects missing fixture images and files."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "smoke_build_graph", Path(__file__).with_name("smoke_build_graph.py")
)
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class TestSmokeBuildGraph(unittest.TestCase):
    def run_probe(self, root: Path, *, missing_image=False, missing_file=False):
        commands = []

        def copy_fixture(_source, destination):
            Path(destination).write_text("fixture")

        def run(command, **kwargs):
            commands.append((command, kwargs))
            if "bake" in command and not missing_file:
                for arch in ("amd64", "rocm"):
                    for path, contents in {
                        "base-marker": "runtime",
                        "opt/frigate/frigate/marker": "application",
                        "opt/frigate/migrations/marker": "migration",
                        "opt/frigate/web/index.html": "frontend",
                    }.items():
                        output = root / arch / path
                        output.parent.mkdir(parents=True, exist_ok=True)
                        output.write_text(contents)

        with (
            patch.object(
                sys,
                "argv",
                [
                    "smoke_build_graph.py",
                    "--root",
                    str(root),
                    "--context",
                    "colima-frigate-build-bench",
                ],
            ),
            patch.object(smoke.shutil, "copyfile", side_effect=copy_fixture),
            patch.object(smoke.subprocess, "run", side_effect=run),
            patch.object(
                smoke,
                "image_digest",
                side_effect=[
                    None if missing_image else "runtime@sha256:" + "a" * 64,
                    "web@sha256:" + "b" * 64,
                ],
            ),
        ):
            if missing_image:
                with self.assertRaisesRegex(RuntimeError, "not published"):
                    smoke.main()
            elif missing_file:
                with self.assertRaises(FileNotFoundError):
                    smoke.main()
            else:
                smoke.main()
        return commands

    def test_published_images_and_built_contents_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = self.run_probe(root)
            self.assertEqual(
                json.loads((root / "passed.json").read_text()),
                {"image_contexts": "passed", "application_contents": "passed"},
            )
            bake = next(
                (command, options) for command, options in commands if "bake" in command
            )
            self.assertIn("fork", bake[0])
            self.assertEqual(
                commands[-1][0][-3:], ["buildx", "rm", "frigate-bench-graph-smoke"]
            )

    def test_missing_image_stops_before_application_build_and_removes_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = self.run_probe(root, missing_image=True)
            self.assertFalse(any("bake" in command for command, _ in commands))
            self.assertFalse((root / "passed.json").exists())
            self.assertEqual(
                commands[-1][0][-3:], ["buildx", "rm", "frigate-bench-graph-smoke"]
            )

    def test_missing_application_content_fails_and_removes_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = self.run_probe(root, missing_file=True)
            self.assertTrue(any("bake" in command for command, _ in commands))
            self.assertFalse((root / "passed.json").exists())
            self.assertEqual(
                commands[-1][0][-3:], ["buildx", "rm", "frigate-bench-graph-smoke"]
            )

    def test_hosted_context_requires_hosted_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "smoke_build_graph.py",
                        "--root",
                        directory,
                        "--context",
                        "frigate-github-bench",
                    ],
                ),
                patch.dict(smoke.os.environ, {"RUNNER_ENVIRONMENT": "self-hosted"}),
                patch.object(smoke.subprocess, "run") as run,
                self.assertRaises(SystemExit) as error,
            ):
                smoke.main()
            self.assertEqual(error.exception.code, 2)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
