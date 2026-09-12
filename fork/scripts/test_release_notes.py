"""Tests for release_notes.py against a throwaway git repository.

python3 -m unittest discover -s fork/scripts -p "test_*.py"
"""

import os
import subprocess
import tempfile
import unittest

import release_notes

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


class ReleaseNotesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        self.git("init", "-q", "-b", "dev")
        self.commit("upstream: initial", "frigate/app.py")
        self.git("tag", "v1.0.0")
        self.git("checkout", "-q", "-b", "main")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            env={**os.environ, **GIT_ENV},
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def commit(self, message: str, *files: str) -> None:
        for name in files:
            path = os.path.join(self.repo, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a") as f:
                f.write(f"{message}\n")
        self.git("add", *files)
        self.git("commit", "-q", "-m", message)

    def build(self, previous: str | None = None) -> release_notes.Notes:
        return release_notes.build("main", previous, "dev", cwd=self.repo)

    def test_groups_by_ledger_id_and_hides_internal_work(self) -> None:
        self.commit("UI1: add a camera wall", "web/src/wall.tsx")
        self.commit("D2: fix a crash on reconnect", "frigate/video.py")
        self.commit("D3: cover the reconnect path", "frigate/test/test_video.py")
        self.commit("I4: faster checks", "frigate/util/ci.py")
        self.commit("E5: patch an advisory", "web/package-lock.json")
        self.commit("F6 + S0: newer web packages", "web/package.json")
        self.commit("fork: scaffold", "web/src/fork/flags.ts")
        self.commit("S0: tick the plan", "fork/PLAN.md")

        notes = self.build()

        self.assertEqual(notes.sections["New"], ["Add a camera wall"])
        self.assertEqual(
            notes.sections["Fixes and improvements"], ["Fix a crash on reconnect"]
        )
        self.assertEqual(notes.sections["Security"], ["Patch an advisory"])
        self.assertEqual(notes.sections["Dependencies"], ["Newer web packages"])
        self.assertEqual(notes.internal, 4)
        self.assertEqual(notes.upstream, "v1.0.0")
        self.assertTrue(notes.first)

    def test_release_note_trailer_overrides_or_hides(self) -> None:
        self.commit(
            "C7: reword the error panel\n\nRelease-note: clearer error messages",
            "web/src/error.tsx",
        )
        self.commit(
            "C8: rename a helper\n\nRelease-note: none",
            "web/src/helper.ts",
        )
        self.commit(
            "I9: CI only, but worth a line\n\nRelease-note: Faster startup",
            "frigate/app.py",
        )

        notes = self.build()

        self.assertEqual(
            notes.sections["Fixes and improvements"],
            ["Clearer error messages", "Faster startup"],
        )
        self.assertEqual(notes.internal, 1)

    def test_since_previous_release_survives_a_rebase(self) -> None:
        self.commit("UI1: add a camera wall", "web/src/wall.tsx")
        self.git("tag", "fork/1")
        self.git("checkout", "-q", "dev")
        self.commit("upstream: newer release", "frigate/other.py")
        self.git("tag", "v1.1.0")
        self.git("checkout", "-q", "main")
        self.git("rebase", "-q", "dev")
        self.commit("UI2: add kiosk mode", "web/src/kiosk.tsx")

        notes = self.build(previous="fork/1")
        markdown = release_notes.to_markdown(notes, "ghcr.io/example/frigate:2")

        self.assertEqual(notes.sections, {"New": ["Add kiosk mode"]})
        self.assertIn("Rebased onto upstream `v1.1.0` (was `v1.0.0`).", markdown)
        self.assertIn("Image: `ghcr.io/example/frigate:2`", markdown)

    def test_markdown_ends_with_the_build_marker(self) -> None:
        self.commit("S0: plan only", "fork/PLAN.md")
        head = self.git("rev-parse", "HEAD").strip()

        markdown = release_notes.to_markdown(self.build(previous="v1.0.0"))

        self.assertIn("No user-facing changes.", markdown)
        self.assertIn(
            "_1 internal change (tests, CI, docs, tooling) not listed._", markdown
        )
        self.assertTrue(markdown.endswith(f"<!-- fork-build: {head} -->"))


if __name__ == "__main__":
    unittest.main()
