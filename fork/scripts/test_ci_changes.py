"""ci-changes.sh must run the suites for every file a gate depends on."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("ci-changes.sh")


def jobs_for(changed: str) -> dict[str, str]:
    """Return the script's outputs for a commit that changes one file."""
    with tempfile.TemporaryDirectory() as directory:
        repo = Path(directory)

        def git(*args: str) -> str:
            result = subprocess.run(
                ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout.strip()

        git("init", "-q")
        (repo / "README.md").write_text("base\n")
        git("add", ".")
        git("commit", "-q", "-m", "base")
        base = git("rev-parse", "HEAD")
        path = repo / changed
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("changed\n")
        git("add", ".")
        git("commit", "-q", "-m", "change")
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("GITHUB_")
        }
        result = subprocess.run(
            ["bash", str(SCRIPT), base],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
    return dict(line.split("=", 1) for line in result.stdout.split())


class TestCiChanges(unittest.TestCase):
    def test_fast_gate_includes_runtime_scripts_and_benchmarks(self):
        check = SCRIPT.with_name("check.sh").read_text()
        pattern = re.search(r"^py_gates='([^']+)'$", check, re.MULTILINE).group(1)
        for path in (
            "fork/scripts/runtime_lock.py",
            "fork/scripts/test_runtime_lock.py",
            "fork/benchmarks/review_summary.py",
        ):
            with self.subTest(path=path):
                selected = subprocess.run(
                    ["bash", "-c", '[[ "$1" =~ $2 ]]', "selector", path, pattern],
                    check=False,
                )
                self.assertEqual(selected.returncode, 0)
                self.assertEqual(jobs_for(path)["python"], "true")

    def test_benchmark_changes_run_python(self):
        self.assertEqual(
            jobs_for("fork/benchmarks/review_summary.py"),
            {"web": "false", "python": "true"},
        )

    def test_docs_only_skips_both_suites(self):
        self.assertEqual(jobs_for("FORK.md"), {"web": "false", "python": "false"})

    def test_a_gate_shell_script_runs_everything(self):
        for name in ("check.sh", "promote.sh", "py-checks.sh", "ci-changes.sh"):
            with self.subTest(name=name):
                self.assertEqual(
                    jobs_for(f"fork/scripts/{name}"),
                    {"web": "true", "python": "true"},
                )

    def test_the_sonar_expiry_file_runs_everything(self):
        self.assertEqual(
            jobs_for("fork/sonar-token.env"), {"web": "true", "python": "true"}
        )

    def test_a_python_script_runs_the_python_suites_only(self):
        self.assertEqual(
            jobs_for("fork/scripts/ledger.py"), {"web": "false", "python": "true"}
        )

    def test_shared_runtime_base_runs_backend_validation(self):
        self.assertEqual(
            jobs_for("fork/runtime-base.env"), {"web": "false", "python": "true"}
        )

    def test_a_ledger_row_runs_the_python_suites_that_validate_it(self):
        self.assertEqual(
            jobs_for("fork/ledger/B10.md"), {"web": "false", "python": "true"}
        )

    def test_web_sources_run_the_web_suites_only(self):
        self.assertEqual(
            jobs_for("web/src/App.tsx"), {"web": "true", "python": "false"}
        )


if __name__ == "__main__":
    unittest.main()
