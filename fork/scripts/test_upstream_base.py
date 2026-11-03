"""Tests for upstream_base.py against a throwaway git repository.

python3 -m unittest discover -s fork/scripts -p "test_*.py"
"""

import contextlib
import io
import os
import subprocess
import tempfile
import unittest

import upstream_base

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


class ParseTest(unittest.TestCase):
    def test_release_reads_the_version_of_a_label(self) -> None:
        self.assertEqual(upstream_base.release("v0.18.2"), (0, 18, 2))
        self.assertEqual(upstream_base.release("v0.18.0-1363-gfbacb760b"), (0, 18, 0))
        self.assertIsNone(upstream_base.release("fbacb760b"))

    def test_claim_skips_comments_and_blank_lines(self) -> None:
        self.assertEqual(upstream_base.parse_claim("# why\n\n v0.18.2 \n"), "v0.18.2")
        self.assertIsNone(upstream_base.parse_claim("# only a comment\n"))

    def test_claim_must_be_a_release_tag(self) -> None:
        for text in ("0.18.2", "v0.18.2-rc1", "v0.18", "--help"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                upstream_base.parse_claim(text)

    def test_newer_takes_the_later_release(self) -> None:
        self.assertEqual(upstream_base.newer("v0.18.0", "v0.18.2"), "v0.18.2")
        self.assertEqual(upstream_base.newer("v0.18.0-12-gabc", "v0.18.2"), "v0.18.2")
        # History that moved past the claim wins, so a stale file is harmless.
        self.assertEqual(upstream_base.newer("v0.19.0", "v0.18.2"), "v0.19.0")
        self.assertEqual(upstream_base.newer("v0.18.2", "v0.18.2"), "v0.18.2")
        self.assertEqual(upstream_base.newer("v0.18.0", None), "v0.18.0")


class LabelTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        self.git("init", "-q", "-b", "dev")
        self.write("frigate/app.py", "upstream\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "upstream: initial")
        self.git("tag", "v0.18.0")
        self.git("checkout", "-q", "-b", "next")
        self.write("web/fork.ts", "fork\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "UI1: a fork change")

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

    def write(self, name: str, text: str) -> None:
        path = os.path.join(self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def claim(self, text: str) -> None:
        self.write(upstream_base.BASE_FILE, text)
        self.git("add", ".")
        self.git("commit", "-q", "-m", "I78: claim")

    def label(self, ref: str = "next", tag: bool = True) -> str:
        return upstream_base.label(ref, "dev", tag=tag, cwd=self.repo)

    def test_without_the_file_the_label_is_the_history(self) -> None:
        self.assertEqual(self.label(), "v0.18.0")

    def test_the_file_names_a_ported_release(self) -> None:
        self.claim("# ported\nv0.18.2\n")
        self.assertEqual(self.label(), "v0.18.2")
        # An older commit keeps its own label, so release notes can say what
        # the previous release was based on.
        self.assertEqual(self.label("next~1"), "v0.18.0")

    def test_history_newer_than_the_file_wins(self) -> None:
        self.claim("v0.18.2\n")
        self.git("checkout", "-q", "dev")
        self.write("frigate/app.py", "upstream 0.19\n")
        self.git("commit", "-qam", "upstream: 0.19")
        self.git("tag", "v0.19.0")
        self.git("checkout", "-q", "next")
        self.git("merge", "-q", "--no-edit", "dev")
        self.assertEqual(self.label(), "v0.19.0")

    def test_without_tag_describe_keeps_its_suffix(self) -> None:
        self.git("checkout", "-q", "dev")
        self.write("frigate/app.py", "upstream later\n")
        self.git("commit", "-qam", "upstream: later")
        self.git("checkout", "-q", "next")
        self.git("merge", "-q", "--no-edit", "dev")
        self.assertRegex(self.label(tag=False), r"^v0\.18\.0-1-g[0-9a-f]+$")
        self.assertEqual(self.label(tag=True), "v0.18.0")

    def test_a_bad_file_fails_loudly(self) -> None:
        self.claim("0.18.2\n")
        with self.assertRaises(ValueError):
            self.label()

    def test_main_prints_the_label(self) -> None:
        self.claim("v0.18.2\n")
        out = io.StringIO()
        cwd = os.getcwd()
        os.chdir(self.repo)
        try:
            with contextlib.redirect_stdout(out):
                code = upstream_base.main(["--upstream", "dev", "--tag"])
        finally:
            os.chdir(cwd)
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), "v0.18.2\n")


if __name__ == "__main__":
    unittest.main()
