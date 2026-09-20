"""Guard the setuptools security pin used by native and runtime images."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestBuildDependencyPins(unittest.TestCase):
    def test_setuptools_lock_and_bootstrap_pins_match_secure_requirement(self):
        requirement = (ROOT / "docker/main/requirements.txt").read_text()
        version = re.search(r"^setuptools\s*==\s*(\S+)", requirement, re.M)[1]
        # 83.0.0 fixes the Unicode MANIFEST exclusion advisory GHSA-h35f-9h28-mq5c.
        self.assertGreaterEqual(tuple(map(int, version.split("."))), (83, 0, 0))
        lock = (ROOT / "docker/main/requirements.lock").read_text()
        self.assertRegex(lock, rf"(?m)^setuptools=={re.escape(version)} ")
        for name, count in (
            ("docker/main/Dockerfile", 3),
            ("docker/rocm/Dockerfile", 1),
            ("docker/tensorrt/Dockerfile.arm64", 1),
        ):
            with self.subTest(dockerfile=name):
                pins = re.findall(r"setuptools==([0-9.]+)", (ROOT / name).read_text())
                self.assertEqual(pins, [version] * count)
