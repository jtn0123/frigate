"""The local CI runner picks CI's jobs, trusts only this repository and reports once."""

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("local_ci", SCRIPTS / "local_ci.py")
assert spec and spec.loader
local_ci = importlib.util.module_from_spec(spec)
sys.modules["local_ci"] = local_ci
spec.loader.exec_module(local_ci)

NOW = 1_800_000_000.0  # 2027-01-15T08:00:00Z


def stamp(seconds_ago: float) -> str:
    import datetime

    moment = datetime.datetime.fromtimestamp(NOW - seconds_ago, datetime.UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class TestGates(unittest.TestCase):
    def test_every_change_gets_the_secrets_scan(self):
        self.assertEqual(local_ci.gates_for({}, everything=False), ["gitleaks"])

    def test_areas_map_to_ci_jobs(self):
        web = local_ci.gates_for({"web": True}, everything=False)
        self.assertEqual(
            web, ["gitleaks", "lint", "typecheck", "ratchet", "i18n", "build", "e2e"]
        )
        coverage = local_ci.gates_for({"coverage": True}, everything=False)
        self.assertEqual(coverage, ["gitleaks", "vitest", "python"])
        python = local_ci.gates_for({"python": True}, everything=False)
        self.assertEqual(python, ["gitleaks", "ruff", "mypy_fork", "scripts", "locks"])
        backend = local_ci.gates_for({"backend": True}, everything=False)
        self.assertEqual(backend, ["gitleaks", "runtime", "audio"])

    def test_a_push_runs_every_gate(self):
        self.assertEqual(
            local_ci.gates_for({"web": False}, everything=True),
            list(local_ci.ALL_GATES),
        )

    def test_every_gate_is_one_check_sh_knows(self):
        script = (SCRIPTS / "check.sh").read_text()
        for gate in local_ci.ALL_GATES:
            self.assertIn(f"gate_{gate}()", script, gate)

    def test_ci_changes_output_is_parsed(self):
        out = "web=true\npython=false\nbackend=true\ncoverage=true\nnoise\n"
        self.assertEqual(
            local_ci.parse_areas(out),
            {"web": True, "python": False, "backend": True, "coverage": True},
        )

    def test_android_job_follows_the_workflow_paths(self):
        self.assertTrue(local_ci.touches_android(["fork/android/app/build.gradle.kts"]))
        self.assertTrue(
            local_ci.touches_android([".github/workflows/fork-android.yml"])
        )
        self.assertFalse(
            local_ci.touches_android([".github/workflows/fork-android-device.yml"])
        )
        self.assertFalse(
            local_ci.touches_android(["web/src/App.tsx", "fork/ledger/X1.md"])
        )


class TestTrust(unittest.TestCase):
    def pr(self, **fields):
        base = {
            "number": 7,
            "isCrossRepository": False,
            "headRepositoryOwner": {"login": "owner"},
            "baseRefName": "next",
        }
        base.update(fields)
        return base

    def test_this_repositorys_branches_run(self):
        local_ci.check_trusted(self.pr(), "owner")
        local_ci.check_trusted(self.pr(baseRefName="main"), "owner")

    def test_pull_requests_from_other_forks_are_refused(self):
        with self.assertRaises(local_ci.Refused):
            local_ci.check_trusted(self.pr(isCrossRepository=True), "owner")
        with self.assertRaises(local_ci.Refused):
            local_ci.check_trusted(
                self.pr(headRepositoryOwner={"login": "someone"}), "owner"
            )

    def test_only_next_and_main_are_tested(self):
        with self.assertRaises(local_ci.Refused):
            local_ci.check_trusted(self.pr(baseRefName="dev"), "owner")


class TestNeedsRun(unittest.TestCase):
    def test_a_commit_without_the_status_runs(self):
        self.assertTrue(local_ci.needs_run([], NOW))
        other = [{"context": "SonarCloud", "state": "success", "updated_at": stamp(5)}]
        self.assertTrue(local_ci.needs_run(other, NOW))

    def test_a_settled_result_is_not_run_again(self):
        for state in ("success", "failure", "error"):
            statuses = [
                {"context": "Checks passed", "state": state, "updated_at": stamp(9)}
            ]
            self.assertFalse(local_ci.needs_run(statuses, NOW), state)

    def test_only_the_newest_status_counts(self):
        statuses = [
            {"context": "Checks passed", "state": "pending", "updated_at": stamp(60)},
            {"context": "Checks passed", "state": "failure", "updated_at": stamp(600)},
        ]
        self.assertFalse(local_ci.needs_run(statuses, NOW))

    def test_a_pending_run_that_died_is_run_again(self):
        stale = local_ci.STALE_PENDING_S + 60
        statuses = [
            {"context": "Checks passed", "state": "pending", "updated_at": stamp(stale)}
        ]
        self.assertTrue(local_ci.needs_run(statuses, NOW))


class TestDescription(unittest.TestCase):
    def test_counts_the_android_job_and_names_no_machine(self):
        text = local_ci.description("success", ["gitleaks", "scripts"], android=True)
        self.assertEqual(text, "Local CI: 3 jobs passed (Sonar not run)")
        self.assertLessEqual(len(text), local_ci.DESCRIPTION_MAX)


class TestCheckGates(unittest.TestCase):
    def check(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(SCRIPTS / "check.sh"), *args],
            capture_output=True,
            text=True,
            cwd=SCRIPTS,
        )

    def test_an_unknown_gate_stops_before_anything_runs(self):
        result = self.check("--gates", "lint,bogus")
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown gate: bogus", result.stderr)

    def test_an_empty_gate_list_is_a_usage_error(self):
        result = self.check("--gates", "")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage", result.stderr)


if __name__ == "__main__":
    unittest.main()
