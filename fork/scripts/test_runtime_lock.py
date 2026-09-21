"""Regression guards for reproducible runtime dependency inputs."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime_lock import INPUTS, ROOT, content_digest, input_digest, update, validate


class TestRuntimeLock(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in INPUTS:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("numpy==1.26.4\n")
        self.path = self.root / "fork/requirements-runtime-amd64.lock"
        self.path.parent.mkdir()
        self.write_lock()

    def write_lock(self, requirement=None, architecture="amd64"):
        requirement = requirement or "tensorflow-cpu==2.19.1 --hash=sha256:" + "a" * 64
        self.path.write_text(
            f"# runtime-content-sha256: {content_digest(requirement)}\n"
            f"# runtime-input-sha256: {input_digest(self.root)}\n"
            f"# runtime-architecture: {architecture}\n{requirement}\n"
        )

    def test_accepts_pinned_hashed_lock(self):
        validate(self.root, "amd64")

    def test_source_and_constraint_drift_are_rejected(self):
        for name in INPUTS:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_text()
                path.write_text(original + "# changed\n")
                with self.assertRaisesRegex(ValueError, "inputs changed"):
                    validate(self.root, "amd64")
                path.write_text(original)

    def test_missing_hash_or_floating_version_is_rejected(self):
        for requirement in [
            "tensorflow-cpu==2.19.1",
            "tensorflow-cpu==2.19.* --hash=sha256:" + "a" * 64,
        ]:
            with self.subTest(requirement=requirement):
                self.write_lock(requirement)
                with self.assertRaisesRegex(ValueError, "unpinned or unhashed"):
                    validate(self.root, "amd64")

    def test_regeneration_stamps_only_successful_resolution(self):
        def compile_lock(command, *, cwd, check):
            self.assertEqual(cwd, self.root)
            self.assertTrue(check)
            self.assertIn("x86_64-manylinux_2_35", command)
            self.path.write_text(
                "tensorflow-cpu==2.19.1 --hash=sha256:" + "b" * 64 + "\n"
            )

        with patch("runtime_lock.subprocess.run", side_effect=compile_lock):
            update(self.root, "amd64")
        validate(self.root, "amd64")
        self.assertIn("b" * 64, self.path.read_text())

    def test_failed_resolver_does_not_stamp_stale_lock(self):
        original = self.path.read_text()
        (self.root / INPUTS[0]).write_text("numpy==1.26.5\n")
        with patch(
            "runtime_lock.subprocess.run",
            side_effect=subprocess.CalledProcessError(1, "uv"),
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                update(self.root, "amd64")
        self.assertEqual(self.path.read_text(), original)
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            validate(self.root, "amd64")

    def test_accidental_entry_deletion_is_rejected(self):
        self.path.write_text(
            "\n".join(
                line
                for line in self.path.read_text().splitlines()
                if not line.startswith("tensorflow-cpu==")
            )
        )
        with self.assertRaisesRegex(ValueError, "generated content changed"):
            validate(self.root, "amd64")

    def test_manual_pin_edit_requires_regeneration(self):
        self.path.write_text(
            self.path.read_text().replace(
                "tensorflow-cpu==2.19.1", "tensorflow-cpu==2.19.2"
            )
        )
        with self.assertRaisesRegex(ValueError, "generated content changed"):
            validate(self.root, "amd64")

    def test_wrong_architecture_is_rejected(self):
        self.write_lock(architecture="arm64")
        with self.assertRaisesRegex(ValueError, "architecture does not match"):
            validate(self.root, "amd64")

    def test_wrong_tensorflow_variant_is_rejected(self):
        self.write_lock("tensorflow==2.19.1 --hash=sha256:" + "a" * 64)
        with self.assertRaisesRegex(ValueError, "TensorFlow"):
            validate(self.root, "amd64")


class TestCommittedRuntimeLocks(unittest.TestCase):
    def test_both_architectures_match_current_inputs(self):
        for architecture in ("amd64", "arm64"):
            with self.subTest(architecture=architecture):
                validate(ROOT, architecture)
