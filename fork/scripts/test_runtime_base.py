"""The shared runtime setting must also be a valid GitHub environment export."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class RuntimeBaseExportTests(unittest.TestCase):
    def test_workflow_exports_only_the_runtime_assignment(self):
        workflow = (ROOT / ".github/workflows/fork-checks.yml").read_text()
        match = re.search(r"- name: Load shared runtime base\n\s+run: (.+)", workflow)
        self.assertIsNotNone(match)
        expected = next(
            line
            for line in (ROOT / "fork/runtime-base.env").read_text().splitlines()
            if line.startswith("FORK_RUNTIME_BASE=")
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github-env"
            subprocess.run(
                ["bash", "-e", "-c", match.group(1)],
                cwd=ROOT,
                env={**os.environ, "GITHUB_ENV": str(output)},
                check=True,
            )
            self.assertEqual(output.read_text().splitlines(), [expected])
