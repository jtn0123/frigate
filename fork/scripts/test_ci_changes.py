"""ci-changes.sh must run the suites for every file a gate depends on."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("ci-changes.sh")


def jobs_for(*changed: str, event: dict[str, str] | None = None) -> dict[str, str]:
    """Return the script's outputs for a commit that changes these files.

    `event` sets GITHUB_EVENT_NAME and GITHUB_REF; without it the run looks
    like a pull request, which keeps the path filter.
    """
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
        for name in changed:
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("changed\n")
        git("add", ".")
        git("commit", "-q", "-m", "change")
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("GITHUB_")
        }
        env.update(event or {})
        result = subprocess.run(
            ["bash", str(SCRIPT), base],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
    return dict(line.split("=", 1) for line in result.stdout.split())


def outputs(web: bool, python: bool, backend: bool, coverage: bool) -> dict[str, str]:
    """The four outputs as the script writes them."""
    flags = {"web": web, "python": python, "backend": backend, "coverage": coverage}
    return {name: str(value).lower() for name, value in flags.items()}


EVERYTHING = outputs(web=True, python=True, backend=True, coverage=True)
PUSH_TO_NEXT = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/next"}


def check_pattern(name: str) -> str:
    """Return a path pattern check.sh assigns to `name`."""
    check = SCRIPT.with_name("check.sh").read_text()
    return re.search(rf"^{name}='([^']+)'$", check, re.MULTILINE).group(1)


def matches(path: str, pattern: str) -> bool:
    """Whether the extended regex `pattern` selects `path`, as touches does."""
    selected = subprocess.run(
        ["bash", "-c", '[[ "$1" =~ $2 ]]', "selector", path, pattern], check=False
    )
    return selected.returncode == 0


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
            outputs(web=False, python=True, backend=True, coverage=True),
        )

    def test_docs_only_skips_every_suite_and_sonar(self):
        for path in ("fork/PLAN.md", "fork/GRADE-REPORT.md", "docs/docs/index.md"):
            with self.subTest(path=path):
                self.assertEqual(
                    jobs_for(path),
                    outputs(web=False, python=False, backend=False, coverage=False),
                )

    def test_android_only_skips_the_backend_suite_and_sonar(self):
        # I69: PR #191 waited 18 minutes for "Checks passed" on python_tests,
        # which nothing in it could break; Sonar excludes fork/android/**.
        self.assertEqual(
            jobs_for(
                "fork/android/app/build.gradle.kts",
                "fork/android/app/src/main/res/values/strings.xml",
                "fork/android/README.md",
                "fork/ledger/AN10.md",
            ),
            outputs(web=False, python=True, backend=False, coverage=False),
        )
        # Without a ledger row nothing in this workflow covers it; Fork -
        # Android does.
        self.assertEqual(
            jobs_for("fork/android/app/src/main/java/com/jtn/frigateviewer/App.kt"),
            outputs(web=False, python=False, backend=False, coverage=False),
        )

    def test_a_ledger_row_runs_only_the_light_python_job(self):
        # I69: test_ledger.py runs in Python - Lint with the whole checkout;
        # the backend image adds nothing a row can break.
        for path in ("fork/ledger/B10.md", "FORK.md"):
            with self.subTest(path=path):
                self.assertEqual(
                    jobs_for(path),
                    outputs(web=False, python=True, backend=False, coverage=False),
                )

    def test_a_backend_source_runs_the_backend_and_both_coverage_suites(self):
        for path in (
            "frigate/app.py",
            "migrations/040_example.py",
            "testing-scripts/example.py",
            "fork/Dockerfile.rootless-test",
            ".dockerignore",
            ".github/workflows/fork-build-benchmark.yml",
        ):
            with self.subTest(path=path):
                self.assertEqual(
                    jobs_for(path),
                    outputs(web=False, python=True, backend=True, coverage=True),
                )

    def test_a_file_sonar_reads_runs_the_coverage_suites(self):
        # Neither web nor backend, but Sonar analyzes it, and Sonar needs both
        # coverage reports from the same revision.
        for path in ("docs/src/pages/index.js", ".github/workflows/fork-android.yml"):
            with self.subTest(path=path):
                self.assertEqual(
                    jobs_for(path),
                    outputs(web=False, python=False, backend=False, coverage=True),
                )

    def test_the_coverage_floor_runs_everything(self):
        # sonar-coverage-check.py holds both reports to this file.
        self.assertEqual(jobs_for("fork/coverage-floor.json"), EVERYTHING)

    def test_a_push_to_next_runs_everything(self):
        for path in ("fork/PLAN.md", "fork/android/README.md", "web/src/App.tsx"):
            with self.subTest(path=path):
                self.assertEqual(jobs_for(path, event=PUSH_TO_NEXT), EVERYTHING)

    def test_a_push_elsewhere_keeps_the_backend_and_coverage_suites(self):
        push_to_main = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main"}
        self.assertEqual(
            jobs_for("fork/android/README.md", event=push_to_main),
            outputs(web=False, python=True, backend=True, coverage=True),
        )

    def test_workflow_dispatch_runs_everything(self):
        dispatch = {"GITHUB_EVENT_NAME": "workflow_dispatch"}
        self.assertEqual(jobs_for("fork/PLAN.md", event=dispatch), EVERYTHING)

    def test_a_gate_shell_script_runs_everything(self):
        for name in ("check.sh", "promote.sh", "py-checks.sh", "ci-changes.sh"):
            with self.subTest(name=name):
                self.assertEqual(jobs_for(f"fork/scripts/{name}"), EVERYTHING)

    def test_the_sonar_expiry_file_runs_everything(self):
        self.assertEqual(jobs_for("fork/sonar-token.env"), EVERYTHING)

    def test_a_python_script_runs_the_python_suites_only(self):
        # The image runs the scripts tests under coverage, so Sonar's report
        # for a changed script comes from the backend suite.
        self.assertEqual(
            jobs_for("fork/scripts/ledger.py"),
            outputs(web=False, python=True, backend=True, coverage=True),
        )

    def test_shared_runtime_base_runs_backend_validation(self):
        self.assertEqual(
            jobs_for("fork/runtime-base.env"),
            outputs(web=False, python=True, backend=True, coverage=True),
        )

    def test_a_runtime_lock_runs_the_python_suites(self):
        # I67: the test image installs these locks, so a change can break
        # the backend tests, in CI and in make check-fast
        gate = check_pattern("py_gates")
        for arch in ("amd64", "arm64"):
            path = f"fork/requirements-runtime-{arch}.lock"
            with self.subTest(path=path):
                self.assertEqual(
                    jobs_for(path),
                    outputs(web=False, python=True, backend=True, coverage=True),
                )
                self.assertTrue(matches(path, gate))

    def test_fast_mode_runs_the_scripts_tests_for_shell_scripts_and_ledgers(self):
        # I67: test_ci_changes.py tests the shell gates and test_ledger.py the
        # rows, so changing either alone must still run the scripts tests
        gate = check_pattern("scripts_gates")
        for path in (
            "fork/scripts/ci-changes.sh",
            "fork/scripts/ledger.py",
            "fork/ledger/B10.md",
        ):
            with self.subTest(path=path):
                self.assertTrue(matches(path, gate))
        self.assertFalse(matches("fork/README.md", gate))

    def test_web_sources_run_the_web_suites_only(self):
        self.assertEqual(
            jobs_for("web/src/App.tsx"),
            outputs(web=True, python=False, backend=False, coverage=True),
        )


if __name__ == "__main__":
    unittest.main()
