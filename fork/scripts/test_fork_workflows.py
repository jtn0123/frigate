"""The fork's workflows keep their action pins and the audio companion's cache."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECKS = ROOT / ".github/workflows/fork-checks.yml"
USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)(.*)$", re.MULTILINE)


def fork_workflow_files() -> list[Path]:
    """The workflows and composite actions the fork owns."""
    return sorted(
        [
            *(ROOT / ".github/workflows").glob("fork-*.yml"),
            *(ROOT / ".github/actions").glob("fork-*/action.yml"),
        ]
    )


def job_block(workflow: str, job: str) -> str:
    """Return the text of one job, from its key to the next job's key."""
    match = re.search(
        rf"^  {re.escape(job)}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
        workflow,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"no job {job}")
    return match.group(1)


class TestActionPins(unittest.TestCase):
    def test_third_party_actions_are_pinned_to_a_commit(self):
        # GitHub's own actions/* and the fork's local actions go by tag; any
        # other publisher's action is pinned to a full commit SHA with the
        # version it was in a trailing comment, so a moved tag cannot change it.
        files = fork_workflow_files()
        self.assertTrue(files)
        for path in files:
            for reference, rest in USES.findall(path.read_text()):
                if reference.startswith(("./", "actions/")):
                    continue
                with self.subTest(file=path.name, uses=reference):
                    self.assertRegex(reference, r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
                    self.assertRegex(rest, r"^\s+#\s*\S")


class TestAudioCompanionCache(unittest.TestCase):
    def setUp(self):
        self.job = job_block(CHECKS.read_text(), "audio_companion")

    def test_image_layers_come_from_the_actions_cache(self):
        # I162: a plain docker build ran apt against snapshot.debian.org on
        # every run, so that host's outages failed the job.
        self.assertNotIn("docker build", self.job)
        self.assertIn("uses: docker/setup-buildx-action@", self.job)
        self.assertIn("uses: docker/build-push-action@", self.job)
        for setting in (
            "context: fork/audio_trial",
            "platforms: linux/amd64",
            "load: true",
            "cache-from: type=gha,scope=audio-companion",
        ):
            with self.subTest(setting=setting):
                self.assertRegex(self.job, rf"(?m)^\s+{re.escape(setting)}$")
        cache_to = re.search(r"(?m)^\s+cache-to:\s*(\S+)$", self.job)
        self.assertIsNotNone(cache_to)
        self.assertEqual(
            set(cache_to.group(1).split(",")),
            {"type=gha", "mode=max", "scope=audio-companion", "ignore-error=true"},
        )
        self.assertNotRegex(self.job, r"(?m)^\s+(no-cache|push):\s*true$")

    def test_every_check_runs_the_image_the_build_loaded(self):
        tag = re.search(r"(?m)^\s+tags:\s*(\S+)$", self.job)
        self.assertIsNotNone(tag)
        self.assertEqual(tag.group(1), "frigate-audio-check")
        # The cache only replaces the build: each check after it still runs.
        steps = re.split(r"(?m)^      - ", self.job)[1:]
        checks = {
            step.splitlines()[0].removeprefix("name:").strip(): step
            for step in steps
            if step.startswith("name:") and "run:" in step
        }
        self.assertEqual(
            list(checks),
            [
                "Recover after forced container termination",
                "Benchmark safety and scoring regressions",
                "Runtime dependency and regression checks",
                "Nonroot read-only offline startup and shutdown",
            ],
        )
        for name, step in checks.items():
            with self.subTest(step=name):
                self.assertIn("frigate-audio-check", step)


if __name__ == "__main__":
    unittest.main()
