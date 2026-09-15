"""Tests for promote.sh against throwaway git repositories.

python3 -m unittest discover -s fork/scripts -p "test_*.py"
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}
# Answers the two gh queries promote.sh makes: Fork - Checks is green on next,
# and there is no previous release.
GH_STUB = """#!/bin/sh
case "$1 $2" in
  "run list") echo completed/success ;;
esac
"""
FEATURE_DATE = "1700000000 +0000"


class PromoteTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.origin = root / "origin.git"
        self.repo = root / "work"
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(GH_STUB)
        (bin_dir / "gh").chmod(0o755)
        self.env = {
            **os.environ,
            **GIT_ENV,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        }
        subprocess.run(
            ["git", "init", "-q", "--bare", str(self.origin)], check=True, env=self.env
        )
        self.repo.mkdir()
        self.git("init", "-q", "-b", "dev")
        self.git("remote", "add", "origin", str(self.origin))
        self.commit("upstream: initial", "frigate/app.py", "upstream\n")
        self.git("tag", "v1.0.0")
        self.git("checkout", "-q", "-b", "next")
        self.commit("UI1: add a camera wall", "web/src/wall.tsx", "wall\n")
        # main was promoted from this next.
        self.git("push", "-q", "--tags", "origin", "dev", "next", "next:main")
        # promote.sh previews the notes with the promoted repository's copy.
        (self.repo / "fork" / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPTS / "release_notes.py", self.repo / "fork" / "scripts")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            env=self.env,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def commit(
        self, message: str, name: str, content: str, date: str = FEATURE_DATE
    ) -> None:
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.git("add", name)
        subprocess.run(
            ["git", "commit", "-q", "-m", message],
            cwd=self.repo,
            env={**self.env, "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date},
            check=True,
        )

    def remote(self, branch: str) -> str:
        return self.git("ls-remote", "origin", f"refs/heads/{branch}").split()[0]

    def promote(self, *args: str, answer: str = "") -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(SCRIPTS / "promote.sh"), *args],
            cwd=self.repo,
            env=self.env,
            input=answer,
            capture_output=True,
            text=True,
        )

    def push_main_only_commit(self) -> str:
        """A fix pushed straight to main, then next moves on without it."""
        self.git("checkout", "-q", "-b", "hotfix", "origin/main")
        self.commit("D2: fix a crash on main", "frigate/video.py", "fix\n")
        self.git("push", "-q", "origin", "hotfix:main")
        self.git("checkout", "-q", "next")
        self.commit("UI3: a new feature", "web/src/feature.tsx", "feature\n")
        self.git("push", "-q", "origin", "next")
        return self.remote("main")

    def test_refuses_a_commit_pushed_to_main_only(self) -> None:
        main = self.push_main_only_commit()

        result = self.promote("--yes")

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("D2: fix a crash on main", result.stderr)
        self.assertIn("--drop-main-commits", result.stderr)
        self.assertEqual(self.remote("main"), main)

    def test_a_commit_rebased_with_conflict_edits_is_on_next(self) -> None:
        promoted = self.git("rev-parse", "next").strip()
        # Upstream moves, and next is rebased onto it with the feature edited
        # to resolve a conflict: same author, date and subject, new patch.
        self.git("checkout", "-q", "dev")
        self.commit("upstream: moves", "web/src/wall.tsx", "upstream wall\n")
        self.git("checkout", "-q", "-B", "next", "dev")
        self.commit("UI1: add a camera wall", "web/src/wall.tsx", "merged wall\n")
        self.git("push", "-q", "origin", "dev", "+next")
        cherry = self.git("cherry", "next", promoted)
        self.assertTrue(cherry.startswith("+ "), cherry)

        result = self.promote("--yes")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote("main"), self.remote("next"))

    def test_drop_flag_lists_the_commits_and_needs_confirmation(self) -> None:
        main = self.push_main_only_commit()

        declined = self.promote("--yes", "--drop-main-commits", answer="y\n")

        self.assertEqual(declined.returncode, 1, declined.stderr)
        self.assertIn("D2: fix a crash on main", declined.stderr)
        self.assertIn("Not promoted.", declined.stderr)
        self.assertEqual(self.remote("main"), main)

        dropped = self.promote("--yes", "--drop-main-commits", answer="drop\n")

        self.assertEqual(dropped.returncode, 0, dropped.stderr)
        self.assertEqual(self.remote("main"), self.remote("next"))


if __name__ == "__main__":
    unittest.main()
