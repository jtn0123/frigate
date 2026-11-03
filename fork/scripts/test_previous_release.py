"""Tests for previous_release.py.

python3 -m unittest discover -s fork/scripts -p "test_*.py"
"""

import contextlib
import io
import json
import subprocess
import unittest
from unittest.mock import patch

import previous_release as pr


def release(tag: str, draft: bool = False, pre: bool = False) -> dict[str, object]:
    return {"tagName": tag, "isDraft": draft, "isPrerelease": pre}


class NewestServerReleaseTest(unittest.TestCase):
    def test_an_android_release_published_later_is_skipped(self) -> None:
        releases = [
            release("android-v0.2.3"),
            release("android-v0.2.2"),
            release("fork/0.18.0-20261017.51"),
            release("fork/0.18.0-20261007.50"),
        ]
        self.assertEqual(pr.newest_server_release(releases), "fork/0.18.0-20261017.51")

    def test_drafts_and_prereleases_are_skipped(self) -> None:
        releases = [
            release("fork/0.19.0-20261101.53", draft=True),
            release("fork/0.19.0-20261101.52", pre=True),
            release("fork/0.18.0-20261017.51"),
        ]
        self.assertEqual(pr.newest_server_release(releases), "fork/0.18.0-20261017.51")

    def test_no_server_release_gives_none(self) -> None:
        self.assertIsNone(pr.newest_server_release([release("android-v0.2.3")]))
        self.assertIsNone(pr.newest_server_release([]))
        self.assertIsNone(pr.newest_server_release([{"tagName": None}]))


class MainTest(unittest.TestCase):
    def run_main(self, releases: list[dict[str, object]]) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(pr.main(["--repo", "o/r"], fetch=lambda _r: releases), 0)
        return out.getvalue()

    def test_prints_the_tag(self) -> None:
        self.assertEqual(
            self.run_main([release("android-v1"), release("fork/1.0")]), "fork/1.0\n"
        )

    def test_prints_nothing_without_a_server_release(self) -> None:
        self.assertEqual(self.run_main([release("android-v1")]), "")

    def test_list_releases_asks_gh_for_the_draft_and_prerelease_flags(self) -> None:
        listed = [release("fork/1.0")]
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(listed))
        with patch.object(pr.subprocess, "run", return_value=done) as run:
            self.assertEqual(pr.list_releases("o/r"), listed)
        args = run.call_args.args[0]
        self.assertEqual(args[:5], ["gh", "release", "list", "-R", "o/r"])
        self.assertIn("tagName,isDraft,isPrerelease", args)

    def test_list_releases_rejects_a_non_list(self) -> None:
        done = subprocess.CompletedProcess([], 0, stdout="{}")
        with patch.object(pr.subprocess, "run", return_value=done):
            with self.assertRaises(ValueError):
                pr.list_releases("o/r")


if __name__ == "__main__":
    unittest.main()
