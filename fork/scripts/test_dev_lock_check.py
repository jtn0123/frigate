"""Require the pinned dev lock to satisfy each declared tool requirement."""

import importlib.util
import tempfile
import unittest
from importlib.metadata import PackageNotFoundError
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "dev_lock_check", Path(__file__).with_name("dev-lock-check.py")
)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


class TestDevLockCheck(unittest.TestCase):
    def test_accepts_matching_versions_and_ignores_comments(self):
        with tempfile.TemporaryDirectory() as directory:
            requirements = Path(directory) / "requirements-dev.txt"
            requirements.write_text("# tools\nruff>=0.12,<1 # lint\n\n")
            with patch.object(check, "version", return_value="0.13.1") as version:
                self.assertEqual(check.unmet_requirements(requirements), [])
            version.assert_called_once_with("ruff")

    def test_reports_missing_and_outdated_packages_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            requirements = Path(directory) / "requirements-dev.txt"
            requirements.write_text("ruff>=0.12\nmypy>=1.18\n")

            def installed(package):
                if package == "ruff":
                    raise PackageNotFoundError(package)
                return "1.17.0"

            with patch.object(check, "version", side_effect=installed):
                self.assertEqual(
                    check.unmet_requirements(requirements),
                    ["ruff>=0.12 (not installed)", "mypy>=1.18 (lock has 1.17.0)"],
                )

    def test_path_uses_first_existing_candidate_and_fails_when_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.txt"
            second = root / "second.txt"
            with patch.object(check, "REQUIREMENTS_CANDIDATES", (first, second)):
                with self.assertRaises(FileNotFoundError):
                    check.requirements_path()
                second.write_text("mypy>=1\n")
                self.assertEqual(check.requirements_path(), second)
                first.write_text("ruff>=0.12\n")
                self.assertEqual(check.requirements_path(), first)

    def test_main_reports_drift_and_returns_failure(self):
        with (
            patch.object(
                check, "requirements_path", return_value=Path("requirements-dev.txt")
            ),
            patch.object(
                check,
                "unmet_requirements",
                return_value=["mypy>=1.18 (lock has 1.17.0)"],
            ),
            patch("sys.stderr") as stderr,
        ):
            self.assertEqual(check.main(), 1)
            self.assertTrue(stderr.write.called)

    def test_main_returns_success_when_every_requirement_matches(self):
        with (
            patch.object(
                check, "requirements_path", return_value=Path("requirements-dev.txt")
            ),
            patch.object(check, "unmet_requirements", return_value=[]),
        ):
            self.assertEqual(check.main(), 0)


if __name__ == "__main__":
    unittest.main()
