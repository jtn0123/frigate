"""The upstream sync must name a bad token's cause and sort upstream's commits."""

import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
import urllib.error
from datetime import date
from pathlib import Path
from unittest import mock

_SPEC = importlib.util.spec_from_file_location(
    "upstream_sync", Path(__file__).with_name("upstream_sync.py")
)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)

REPO = "jtn0123/frigate"
TODAY = date(2026, 11, 1)


class TestClassifyToken(unittest.TestCase):
    def test_a_rejected_token_is_expired_and_fatal(self):
        check = _MODULE.classify_token(REPO, 401, None, TODAY)
        self.assertEqual(check.state, "expired")
        self.assertTrue(check.fatal)
        self.assertIn("expired or was revoked", check.message)
        self.assertIn("Workflows: Read and write", check.message)

    def test_a_token_without_the_repository_is_fatal(self):
        for status in (403, 404):
            check = _MODULE.classify_token(REPO, status, None, TODAY)
            self.assertEqual(check.state, "no_access")
            self.assertTrue(check.fatal)
            self.assertIn(REPO, check.message)

    def test_an_unreachable_api_only_warns(self):
        for status in (None, 500):
            check = _MODULE.classify_token(REPO, status, None, TODAY)
            self.assertEqual(check.state, "unknown")
            self.assertFalse(check.fatal)
            self.assertEqual(check.level, "warning")

    def test_warns_within_fourteen_days_of_expiry(self):
        check = _MODULE.classify_token(REPO, 200, "2026-11-15 07:00:00 UTC", TODAY)
        self.assertEqual(check.state, "expiring")
        self.assertEqual(check.level, "warning")
        self.assertEqual(check.expires, "2026-11-15")
        self.assertIn("in 14 day(s)", check.message)

    def test_a_later_expiry_is_a_notice(self):
        check = _MODULE.classify_token(REPO, 200, "2026-11-16 07:00:00 UTC", TODAY)
        self.assertEqual(check.state, "valid")
        self.assertEqual(check.level, "notice")
        self.assertEqual(check.expires, "2026-11-16")

    def test_a_token_without_expiry_is_valid(self):
        check = _MODULE.classify_token(REPO, 200, None, TODAY)
        self.assertEqual(check.state, "valid")
        self.assertEqual(check.expires, "")
        self.assertIn("never expires", check.message)


class _Response:
    def __init__(self, status, headers):
        self.status = status
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestProbeToken(unittest.TestCase):
    def test_reads_the_status_and_expiration_header(self):
        header = {"github-authentication-token-expiration": "2027-01-01 00:00:00 UTC"}
        with mock.patch.object(
            _MODULE.urllib.request, "urlopen", return_value=_Response(200, header)
        ) as urlopen:
            result = _MODULE.probe_token("secret-value", REPO)
        self.assertEqual(result, (200, "2027-01-01 00:00:00 UTC"))
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, f"https://api.github.com/repos/{REPO}")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-value")

    def test_an_http_error_returns_its_code(self):
        error = urllib.error.HTTPError("u", 401, "Bad credentials", {}, None)
        with mock.patch.object(_MODULE.urllib.request, "urlopen", side_effect=error):
            self.assertEqual(_MODULE.probe_token("t", REPO), (401, None))

    def test_a_network_error_returns_no_status(self):
        error = urllib.error.URLError("down")
        with mock.patch.object(_MODULE.urllib.request, "urlopen", side_effect=error):
            self.assertEqual(_MODULE.probe_token("t", REPO), (None, None))


class TestMainToken(unittest.TestCase):
    def run_main(self, env, probe=None):
        with tempfile.TemporaryDirectory() as tmp:
            output = os.path.join(tmp, "out")
            env = {"GITHUB_REPOSITORY": REPO, "GITHUB_OUTPUT": output, **env}
            stdout = io.StringIO()
            with (
                mock.patch.dict(os.environ, env, clear=True),
                mock.patch.object(_MODULE, "probe_token", return_value=probe),
                contextlib.redirect_stdout(stdout),
            ):
                rc = _MODULE.main_token(TODAY)
            return rc, stdout.getvalue(), Path(output).read_text()

    def test_a_missing_secret_stops_the_job(self):
        rc, stdout, output = self.run_main({})
        self.assertEqual(rc, 1)
        self.assertIn("::error title=FORK_SYNC_TOKEN missing::", stdout)
        self.assertIn("state=missing\n", output)

    def test_an_expired_token_stops_the_job_without_printing_it(self):
        rc, stdout, output = self.run_main(
            {"FORK_SYNC_TOKEN": "secret-value"}, probe=(401, None)
        )
        self.assertEqual(rc, 1)
        self.assertIn("::error title=FORK_SYNC_TOKEN expired::", stdout)
        self.assertNotIn("secret-value", stdout + output)
        self.assertIn("state=expired\n", output)

    def test_a_valid_token_passes_and_records_the_expiry(self):
        rc, stdout, output = self.run_main(
            {"FORK_SYNC_TOKEN": "t"}, probe=(200, "2027-03-01 00:00:00 UTC")
        )
        self.assertEqual(rc, 0)
        self.assertIn("::notice title=FORK_SYNC_TOKEN valid::", stdout)
        self.assertIn("expires=2027-03-01\n", output)


class TestParsing(unittest.TestCase):
    def test_translations_are_recognised(self):
        for subject in (
            "Translated using Weblate (Slovak)",
            "Update translation files",
            "Added translation using Weblate (Georgian)",
            "Translations update from Hosted Weblate (#24333)",
        ):
            self.assertTrue(_MODULE.is_translation(subject), subject)
        self.assertFalse(_MODULE.is_translation("Fix translation of a key (#1)"))

    def test_pull_request_number_comes_from_the_subject_suffix(self):
        self.assertEqual(_MODULE.Commit("a", "Tweaks (#24684)").pr, "24684")
        self.assertIsNone(_MODULE.Commit("a", "Update translation files").pr)
        self.assertIsNone(_MODULE.Commit("a", "Revert #24684 for now").pr)

    def test_parse_log_skips_malformed_lines(self):
        commits = _MODULE.parse_log("abc\0First (#1)\nnoise\ndef\0Second\n")
        self.assertEqual(
            commits,
            [_MODULE.Commit("abc", "First (#1)"), _MODULE.Commit("def", "Second")],
        )

    def test_cited_refs_reads_cherry_picks_and_upstream_numbers(self):
        shas, prs = _MODULE.cited_refs(
            [
                "UI151: grids (upstream #24461)\n\n"
                "(cherry picked from commit 0977fa5e15cba802c9df7f8b21edf62b56075baf)",
                "| B32 | ... | - #24607 lock zmq | Merge pull request #163 |",
            ]
        )
        self.assertEqual(shas, {"0977fa5e15cba802c9df7f8b21edf62b56075baf"})
        # #163 is the fork's own pull request, not an upstream one
        self.assertEqual(prs, {"24461", "24607"})

    def test_parse_merge_tree(self):
        self.assertEqual(_MODULE.parse_merge_tree(0, "tree1\n"), ("tree1", []))
        self.assertEqual(
            _MODULE.parse_merge_tree(1, "tree2\nb.py\na.py\nb.py\n\n"),
            ("", ["a.py", "b.py"]),
        )
        with self.assertRaises(RuntimeError):
            _MODULE.parse_merge_tree(128, "fatal: bad object")
        with self.assertRaises(RuntimeError):
            _MODULE.parse_merge_tree(0, "")


def fake_git(merge_rc=1):
    """A git runner for a small history: five upstream commits next lacks."""
    log = "\n".join(
        [
            "e5\0Conflicting fix (#24806)",
            "d4\0Clean fix (#24728)",
            "c3\0Translated using Weblate (French)",
            "b2\0Ported by hand (#24607)",
            "a1aaaaaa\0Cherry-picked (#24461)",
            "f6\0Same patch (#24500)",
        ]
    )
    calls = []

    def run(args):
        calls.append(list(args))
        match args[0]:
            case "rev-parse":
                return 0, "upstreamsha\n"
            case "log" if "--no-merges" in args:
                return 0, log + "\n"
            case "log":
                return (
                    0,
                    "B32: port\n\n- #24607 zmq\n(cherry picked from commit a1aaaaaa)\0",
                )
            case "cherry":
                return 0, "+ e5\n+ d4\n- f6\n"
            case "merge-base":
                return 0, "base\n"
            case "grep":
                return 0, "| UI151 | ... | upstream #24461 |\n"
            case "merge-tree" if "--merge-base=e5^" in args:
                return 1, "t\nfrigate/api/media.py\n"
            case "merge-tree" if any(a.startswith("--merge-base") for a in args):
                return 0, "t\n"
            case "merge-tree":
                return merge_rc, "mergetree\n" + (
                    "frigate/app.py\n" if merge_rc else ""
                )
        raise AssertionError(args)

    return run, calls


class TestBuildReport(unittest.TestCase):
    def test_sorts_every_commit_into_one_bucket(self):
        run, calls = fake_git()
        report = _MODULE.build_report(run, "origin/next", "upstream/dev")

        def shas(items):
            return [c.sha for c in items]

        self.assertEqual(report.upstream, "upstreamsha")
        self.assertEqual(len(report.commits), 6)
        self.assertEqual(shas(report.in_next), ["f6", "a1aaaaaa"])
        self.assertEqual(shas(report.cited), ["b2"])
        self.assertEqual(shas(report.translations), ["c3"])
        self.assertEqual(shas(report.clean), ["d4"])
        self.assertEqual(
            [(c.sha, files) for c, files in report.conflicting],
            [("e5", ["frigate/api/media.py"])],
        )
        self.assertEqual(report.merge_tree, "")
        self.assertEqual(report.merge_conflicts, ["frigate/app.py"])
        # only the two commits nobody took are tried as cherry-picks
        picks = [c for c in calls if c[0] == "merge-tree" and len(c) == 7]
        self.assertEqual(len(picks), 2)

    def test_a_clean_merge_keeps_the_tree(self):
        run, _ = fake_git(merge_rc=0)
        report = _MODULE.build_report(run, "origin/next", "upstream/dev")
        self.assertEqual(report.merge_tree, "mergetree")
        self.assertEqual(report.merge_conflicts, [])

    def test_nothing_to_do_when_next_has_everything(self):
        def run(args):
            if args[0] == "rev-parse":
                return 0, "sha\n"
            if args[0] == "log":
                return 0, ""
            raise AssertionError(args)

        report = _MODULE.build_report(run, "origin/next", "upstream/dev")
        self.assertEqual(report.commits, [])
        self.assertEqual(report.merge_tree, "")


class TestRenderBody(unittest.TestCase):
    def report(self, clean=3):
        run, _ = fake_git()
        report = _MODULE.build_report(run, "origin/next", "upstream/dev")
        report.clean = [
            _MODULE.Commit(f"{i:040d}", f"Fix number {i} (#2{i:04d})")
            for i in range(clean)
        ]
        return report

    def test_lists_counts_conflicts_and_candidates(self):
        body = _MODULE.render_body(self.report())
        self.assertIn("has 6 commit(s)", body)
        self.assertIn("| Translations (Weblate) | 1 |", body)
        self.assertIn("| Apply cleanly to next as a cherry-pick | 3 |", body)
        self.assertIn("conflicts in 1 file(s)", body)
        self.assertIn("- frigate/app.py", body)
        self.assertIn("e5 Conflicting fix (#24806): frigate/api/media.py", body)
        self.assertIn("### Cited by next", body)
        self.assertNotIn("sync/upstream, where", body)

    def test_a_clean_merge_points_at_sync_upstream(self):
        report = self.report()
        report.merge_conflicts = []
        report.merge_tree = "tree"
        self.assertIn("The merge is on sync/upstream", _MODULE.render_body(report))

    def test_long_lists_are_cut(self):
        body = _MODULE.render_body(self.report(clean=12), limit=10)
        self.assertIn("- ... and 2 more", body)

    def test_fit_body_stays_under_the_limit(self):
        report = self.report(clean=3000)
        body = _MODULE.fit_body(report, budget=20000)
        self.assertLessEqual(len(body), 20000)
        self.assertIn("more", body)
        self.assertIn("| Apply cleanly to next as a cherry-pick | 3000 |", body)

    def test_fit_body_truncates_as_a_last_resort(self):
        body = _MODULE.fit_body(self.report(), budget=200)
        self.assertLessEqual(len(body), 200)
        self.assertTrue(body.endswith("(truncated)\n"))


class TestMainReport(unittest.TestCase):
    def test_writes_the_body_and_outputs(self):
        run, _ = fake_git(merge_rc=0)
        with tempfile.TemporaryDirectory() as tmp:
            body = os.path.join(tmp, "body.md")
            output = os.path.join(tmp, "out")
            stdout = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"GITHUB_OUTPUT": output}, clear=True),
                mock.patch.object(_MODULE, "_git", run),
                contextlib.redirect_stdout(stdout),
            ):
                rc = _MODULE.main(["report", "--body", body])
            self.assertEqual(rc, 0)
            self.assertIn("has 6 commit(s)", Path(body).read_text())
            self.assertIn('"clean": 1', stdout.getvalue())
            outputs = Path(output).read_text()
        self.assertIn("missing=6\n", outputs)
        self.assertIn("merge_tree=mergetree\n", outputs)
        self.assertIn("merge_conflicts=0\n", outputs)

    def test_token_command_dispatches(self):
        with mock.patch.object(_MODULE, "main_token", return_value=1) as token:
            self.assertEqual(_MODULE.main(["token"]), 1)
        token.assert_called_once_with()

    def test_git_runner_returns_code_and_output(self):
        done = mock.Mock(returncode=1, stdout="tree\n")
        with mock.patch.object(_MODULE.subprocess, "run", return_value=done) as run:
            self.assertEqual(_MODULE._git(["merge-tree", "a", "b"]), (1, "tree\n"))
        self.assertEqual(run.call_args.args[0], ["git", "merge-tree", "a", "b"])
        self.assertFalse(run.call_args.kwargs["check"])


if __name__ == "__main__":
    unittest.main()
