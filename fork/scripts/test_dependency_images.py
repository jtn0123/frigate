"""Verify that dependency reuse cannot silently ignore changed build inputs."""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "dependency_images", Path(__file__).with_name("dependency_images.py")
)
dependencies = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dependencies)


class TestDependencyImages(unittest.TestCase):
    def test_regular_application_stage_does_not_repeat_system_setup(self):
        source = (
            Path(__file__).resolve().parents[2] / "docker/main/Dockerfile"
        ).read_text()
        stage = re.search(
            r"^FROM [^\n]+ AS frigate\n(.*)", source, re.MULTILINE | re.DOTALL
        )
        self.assertIsNotNone(stage)
        self.assertNotRegex(stage.group(1), r"(?m)^RUN ")
        self.assertIn("COPY --link --from=rootfs / /", stage.group(1))
        self.assertLess(source.index("bash /tmp/prepare_rootless.sh"), stage.start())

    def test_frontend_only_change_does_not_rebuild_runtime_dependencies(self):
        digest = "example.invalid/image@sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "dependency_images.py",
                "--repository",
                "example.invalid/image",
                "--cache",
                "example.invalid/image:cache",
                "--amd64-tags",
                "example.invalid/image:app-amd64",
                "--rocm-tags",
                "example.invalid/image:app-rocm",
                "--output",
                directory,
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(dependencies, "dependency_key", return_value="test-key"),
                patch.object(dependencies, "web_key", return_value="web-key"),
                patch.object(
                    dependencies,
                    "image_digest",
                    side_effect=[digest, digest, None, digest, digest, digest],
                ),
                patch.object(dependencies.subprocess, "run") as run,
            ):
                dependencies.main()
            self.assertEqual(run.call_count, 2)
            prepare = run.call_args_list[0].args[0]
            self.assertEqual(prepare[-1], "web")
            self.assertNotIn("dependencies", prepare)
            report = json.loads((Path(directory) / "results.json").read_text())
            self.assertTrue(report["dependencies_reused"])
            self.assertFalse(report["web_reused"])

    def test_frontend_sources_invalidate_artifact_but_backend_and_output_do_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "web/src/App.tsx",
                "docker/main/Dockerfile",
                "docker/fork-dependencies.hcl",
                ".dockerignore",
                "fork/scripts/dependency_images.py",
            ):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture\n")
            key = dependencies.web_key(root, "generation")
            for name in (
                "frigate/app.py",
                "web/dist/index.html",
                "web/node_modules/package/index.js",
                "web/.npm/cache",
            ):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("generated\n")
            self.assertEqual(key, dependencies.web_key(root, "generation"))
            (root / "web/src/App.tsx").write_text("changed source\n")
            self.assertNotEqual(key, dependencies.web_key(root, "generation"))

    def test_explicit_refresh_bypasses_cache_even_when_images_exist(self):
        digest = "example.invalid/image@sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "dependency_images.py",
                "--repository",
                "example.invalid/image",
                "--cache",
                "example.invalid/image:cache",
                "--amd64-tags",
                "example.invalid/image:app-amd64",
                "--rocm-tags",
                "example.invalid/image:app-rocm",
                "--output",
                directory,
                "--rebuild-dependencies",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(dependencies, "dependency_key", return_value="test-key"),
                patch.object(dependencies, "web_key", return_value="web-key"),
                patch.object(dependencies, "image_digest", return_value=digest),
                patch.object(dependencies.subprocess, "run") as run,
            ):
                dependencies.main()
            self.assertEqual(run.call_count, 2)
            dependency_command = run.call_args_list[0].args[0]
            self.assertIn("--no-cache", dependency_command)
            self.assertIn("--pull", dependency_command)
            self.assertNotIn("--no-cache", run.call_args_list[1].args[0])
            report = json.loads((Path(directory) / "results.json").read_text())
            self.assertFalse(report["dependencies_reused"])
            self.assertTrue(report["dependency_cache_bypassed"])

    def test_reused_images_skip_dependency_build_and_pin_runtime_inputs(self):
        digest = "example.invalid/image@sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "dependency_images.py",
                "--repository",
                "example.invalid/image",
                "--cache",
                "example.invalid/image:cache",
                "--amd64-tags",
                "example.invalid/image:app-amd64",
                "--rocm-tags",
                "example.invalid/image:app-rocm",
                "--output",
                directory,
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(dependencies, "dependency_key", return_value="test-key"),
                patch.object(dependencies, "web_key", return_value="web-key"),
                patch.object(dependencies, "image_digest", return_value=digest),
                patch.object(dependencies.subprocess, "run") as run,
            ):
                dependencies.main()
            self.assertEqual(run.call_count, 1)
            self.assertIn("docker/fork-runtime.hcl", run.call_args.args[0])
            self.assertEqual(
                run.call_args.kwargs["env"]["DEPENDENCY_ROCM_IMAGE"], digest
            )
            report = json.loads((Path(directory) / "results.json").read_text())
            self.assertTrue(report["dependencies_reused"])
            self.assertEqual(report["dependency_seconds"], 0)

    def test_failed_dependency_build_never_starts_application_build(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = [
                "dependency_images.py",
                "--repository",
                "example.invalid/image",
                "--cache",
                "example.invalid/image:cache",
                "--amd64-tags",
                "example.invalid/image:app-amd64",
                "--rocm-tags",
                "example.invalid/image:app-rocm",
                "--output",
                directory,
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(dependencies, "dependency_key", return_value="test-key"),
                patch.object(dependencies, "web_key", return_value="web-key"),
                patch.object(dependencies, "image_digest", return_value=None),
                patch.object(
                    dependencies.subprocess,
                    "run",
                    side_effect=subprocess.CalledProcessError(1, "build"),
                ) as run,
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    dependencies.main()
            self.assertEqual(run.call_count, 1)
            self.assertIn("docker/fork-dependencies.hcl", run.call_args.args[0])
            self.assertFalse((Path(directory) / "results.json").exists())

    def test_application_graph_has_only_pinned_dependencies_and_application(self):
        digest = "ghcr.io/example/frigate@sha256:" + "a" * 64
        env = os.environ | {
            "DEPENDENCY_AMD64_IMAGE": digest,
            "DEPENDENCY_ROCM_IMAGE": digest,
            "WEB_ASSETS_IMAGE": digest,
            "CACHE": "example.invalid/frigate:cache",
            "AMD64_TAGS": "example.invalid/frigate:amd64",
            "ROCM_TAGS": "example.invalid/frigate:rocm",
            "RUNTIME_CACHE_FROM": "example.invalid/frigate:cache-app",
        }
        result = subprocess.run(
            [
                "docker",
                "buildx",
                "bake",
                "-f",
                "docker/fork-runtime.hcl",
                "--print",
                "fork",
            ],
            cwd=Path(__file__).resolve().parents[2],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        targets = json.loads(result.stdout)["target"]
        self.assertEqual(set(targets), {"amd64", "rocm", "rootfs"})
        self.assertEqual(
            targets["rootfs"]["contexts"], {"web-build": "docker-image://" + digest}
        )
        original = subprocess.run(
            [
                "docker",
                "buildx",
                "bake",
                "-f",
                "docker/rocm/rocm.hcl",
                "--print",
                "rocm",
            ],
            cwd=Path(__file__).resolve().parents[2],
            env=env | {"HSA_OVERRIDE": "0"},
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(
            targets["rocm"]["args"],
            json.loads(original.stdout)["target"]["rocm"]["args"],
        )
        for name, base in (("amd64", "frigate-runtime"), ("rocm", "rocm-runtime")):
            self.assertEqual(
                targets[name]["contexts"][base], "docker-image://" + digest
            )
            self.assertEqual(targets[name]["contexts"]["rootfs"], "target:rootfs")
            self.assertEqual(targets[name]["platforms"], ["linux/amd64"])

    def test_registry_error_is_not_treated_as_missing_dependencies(self):
        for error in (b"unauthorized", b"connection refused", b"429 Too Many Requests"):
            with patch.object(
                dependencies.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 1, b"", error),
            ):
                with self.assertRaises(RuntimeError):
                    dependencies.image_digest(["docker"], "example.invalid/image:tag")

    def test_registry_digest_is_used_without_rehashing_formatted_output(self):
        digest = "sha256:" + "a" * 64
        result = subprocess.CompletedProcess(
            [], 0, json.dumps({"digest": digest}).encode(), b""
        )
        with patch.object(dependencies.subprocess, "run", return_value=result):
            self.assertEqual(
                dependencies.image_digest(["docker"], "localhost:5007/image:tag"),
                "localhost:5007/image@" + digest,
            )

    def test_application_change_reuses_key_but_dependency_change_invalidates_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in dependencies.INPUT_PATHS:
                path = root / name
                if name == "docker":
                    path.mkdir()
                    (path / "Dockerfile").write_text("FROM debian:12\n")
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("fixture\n")
            key = dependencies.dependency_key(root, "2026-09")
            (root / "frigate").mkdir()
            (root / "frigate/app.py").write_text("changed application\n")
            self.assertEqual(key, dependencies.dependency_key(root, "2026-09"))
            dependency = root / "docker/new-install-script.sh"
            dependency.write_text("dependency\n")
            changed = dependencies.dependency_key(root, "2026-09")
            self.assertNotEqual(key, changed)
            dependency.chmod(0o755)
            self.assertNotEqual(changed, dependencies.dependency_key(root, "2026-09"))
            self.assertNotEqual(key, dependencies.dependency_key(root, "2026-10"))

    def test_missing_input_fails_instead_of_reusing_incomplete_key(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                dependencies.dependency_key(Path(directory), "2026-09")

    def test_runtime_references_require_exact_digest(self):
        valid = "ghcr.io/example/frigate@sha256:" + "a" * 64
        self.assertEqual(dependencies.validate_digest(valid), valid)
        for invalid in ("ghcr.io/example/frigate:latest", "", valid + "\n"):
            with self.assertRaises(ValueError):
                dependencies.validate_digest(invalid)


if __name__ == "__main__":
    unittest.main()
