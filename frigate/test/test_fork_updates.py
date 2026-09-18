"""Tests for the fork update checker (fork UI42)."""

import threading
import unittest
from typing import Any

from requests.exceptions import ConnectionError as RequestsConnectionError

from frigate.fork.updates import (
    CHECK_INTERVAL_SECONDS,
    MIN_REFRESH_SECONDS,
    ForkUpdateChecker,
    build_sha,
    parse_release,
)

SHA_NEW = "c" * 40
SHA_MID = "b" * 40
SHA_OLD = "a" * 40


def release(tag: str, sha: str, **extra: Any) -> dict[str, Any]:
    return {
        "tag_name": tag,
        "name": tag.removeprefix("fork/"),
        "body": f"### New\n\n- Something\n\n<!-- fork-build: {sha} -->",
        "html_url": f"https://github.com/jtn0123/frigate/releases/tag/{tag}",
        "published_at": "2026-09-11T12:00:00Z",
        "draft": False,
        "prerelease": False,
        **extra,
    }


RELEASES = [
    release("fork/3", SHA_NEW),
    release("fork/2", SHA_MID),
    release("fork/1", SHA_OLD),
]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


class FakeFetch:
    def __init__(self, result: list[dict[str, Any]] | Exception) -> None:
        self.result = result
        self.calls = 0

    def __call__(self) -> list[dict[str, Any]]:
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class TestForkUpdates(unittest.TestCase):
    def checker(
        self, version: str, result: list[dict[str, Any]] | Exception = RELEASES
    ) -> tuple[ForkUpdateChecker, FakeFetch, FakeClock]:
        fetch = FakeFetch(result)
        clock = FakeClock()
        return ForkUpdateChecker(version, fetch=fetch, clock=clock), fetch, clock

    def test_build_sha_reads_the_make_version_suffix(self) -> None:
        self.assertEqual(build_sha("0.18.0-94d7d292a"), "94d7d292a")
        self.assertIsNone(build_sha("0.18.0"))
        self.assertIsNone(build_sha("dev"))

    def test_parse_release_skips_drafts_prereleases_and_unmarked_bodies(
        self,
    ) -> None:
        self.assertIsNone(parse_release(release("fork/x", SHA_NEW, draft=True)))
        self.assertIsNone(parse_release(release("fork/x", SHA_NEW, prerelease=True)))
        self.assertIsNone(parse_release({**release("fork/x", SHA_NEW), "body": "hi"}))

        parsed = parse_release(release("fork/3", SHA_NEW))
        assert parsed is not None
        self.assertEqual(parsed.sha, SHA_NEW)
        self.assertEqual(parsed.name, "3")
        self.assertNotIn("fork-build", parsed.notes)

    def test_parse_release_turns_the_folded_block_into_a_heading(self) -> None:
        body = (
            "### New\n\n- Kiosk mode\n\n<details>\n"
            "<summary>Under the hood (1)</summary>\n\n- Ratchet\n\n</details>\n\n"
            f"<!-- fork-build: {SHA_NEW} -->"
        )

        parsed = parse_release({**release("fork/4", SHA_NEW), "body": body})

        assert parsed is not None
        self.assertEqual(
            parsed.notes,
            "### New\n\n- Kiosk mode\n\n### Under the hood (1)\n\n- Ratchet",
        )

    def test_older_build_reports_newer_releases(self) -> None:
        checker, _, _ = self.checker(f"0.18.0-{SHA_OLD[:9]}")

        state = checker.state()

        self.assertEqual(state["status"], "available")
        self.assertEqual(state["newer_count"], 2)
        self.assertEqual(state["current_tag"], "fork/1")
        self.assertEqual(state["latest_tag"], "fork/3")
        self.assertEqual(
            [r["tag"] for r in state["releases"]], ["fork/3", "fork/2", "fork/1"]
        )

    def test_latest_build_is_up_to_date(self) -> None:
        checker, _, _ = self.checker(f"0.18.0-{SHA_NEW[:7]}")

        state = checker.state()

        self.assertEqual(state["status"], "up-to-date")
        self.assertEqual(state["newer_count"], 0)

    def test_build_missing_from_releases_is_a_development_build(self) -> None:
        checker, _, _ = self.checker("0.18.0-0123abcd")

        state = checker.state()

        self.assertEqual(state["status"], "development")
        self.assertIsNone(state["current_tag"])

    def test_unreachable_github_reports_unknown_without_raising(self) -> None:
        checker, _, _ = self.checker(
            f"0.18.0-{SHA_OLD[:9]}", RequestsConnectionError("offline")
        )

        state = checker.state()

        self.assertEqual(state["status"], "unknown")
        self.assertEqual(state["error"], "unreachable")

    def test_caches_between_checks_and_rate_limits_forced_refreshes(self) -> None:
        checker, fetch, clock = self.checker(f"0.18.0-{SHA_OLD[:9]}")

        checker.state()
        checker.state()
        self.assertEqual(fetch.calls, 1)

        clock.now += MIN_REFRESH_SECONDS - 1
        checker.state(force=True)
        self.assertEqual(fetch.calls, 1)

        clock.now += 1
        checker.state(force=True)
        self.assertEqual(fetch.calls, 2)

        clock.now += CHECK_INTERVAL_SECONDS
        checker.state()
        self.assertEqual(fetch.calls, 3)

    def test_keeps_last_releases_when_a_refresh_fails(self) -> None:
        checker, fetch, clock = self.checker(f"0.18.0-{SHA_OLD[:9]}")
        checker.state()

        fetch.result = RequestsConnectionError("offline")
        clock.now += CHECK_INTERVAL_SECONDS
        state = checker.state()

        self.assertEqual(state["status"], "available")
        self.assertEqual(state["error"], "unreachable")


class BlockingFetch:
    """A fetch that says when it started and waits until it is let go."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def __call__(self) -> list[dict[str, Any]]:
        self.calls += 1
        self.started.set()
        if not self.release.wait(timeout=10):
            raise AssertionError("the test never released the fetch")
        return RELEASES


class TestForkUpdatesConcurrency(unittest.TestCase):
    """B6: the GitHub request runs outside the checker's lock."""

    def test_a_second_caller_is_not_blocked_by_a_slow_fetch(self) -> None:
        fetch = BlockingFetch()
        checker = ForkUpdateChecker(
            f"0.18.0-{SHA_OLD[:9]}", fetch=fetch, clock=FakeClock()
        )
        states: dict[str, dict[str, Any]] = {}

        def call(name: str, force: bool = False) -> None:
            states[name] = checker.state(force=force)

        first = threading.Thread(target=call, args=("first",))
        first.start()
        self.addCleanup(first.join, 10)
        self.addCleanup(fetch.release.set)
        self.assertTrue(fetch.started.wait(timeout=10))

        # The fetch is still in progress; these return the cached state.
        for name, force in (("second", False), ("forced", True)):
            caller = threading.Thread(target=call, args=(name, force))
            caller.start()
            caller.join(timeout=10)
            self.assertFalse(caller.is_alive(), f"{name} caller was blocked")

        self.assertTrue(first.is_alive())
        self.assertIsNone(states["second"]["checked_at"])
        self.assertEqual(states["second"]["releases"], [])
        self.assertEqual(states["forced"], states["second"])
        self.assertEqual(fetch.calls, 1, "one refresh at a time")

        fetch.release.set()
        first.join(timeout=10)

        self.assertFalse(first.is_alive())
        self.assertEqual(states["first"]["status"], "available")
        self.assertEqual(checker.state()["latest_tag"], "fork/3")
        self.assertEqual(fetch.calls, 1)

    def test_an_unexpected_fetch_error_does_not_end_refreshing_for_good(self) -> None:
        fetch = FakeFetch(RuntimeError("bug"))
        clock = FakeClock()
        checker = ForkUpdateChecker(f"0.18.0-{SHA_OLD[:9]}", fetch=fetch, clock=clock)

        with self.assertRaises(RuntimeError):
            checker.state()

        fetch.result = RELEASES
        clock.now += CHECK_INTERVAL_SECONDS
        self.assertEqual(checker.state()["status"], "available")
        self.assertEqual(fetch.calls, 2)

    def test_an_unexpected_fetch_error_counts_as_a_check(self) -> None:
        """B11: the next polls wait for the interval instead of refetching."""
        fetch = FakeFetch(RuntimeError("bug"))
        clock = FakeClock()
        checker = ForkUpdateChecker(f"0.18.0-{SHA_OLD[:9]}", fetch=fetch, clock=clock)

        with self.assertRaises(RuntimeError):
            checker.state()

        clock.now += CHECK_INTERVAL_SECONDS - 1
        state = checker.state()
        self.assertEqual(fetch.calls, 1)
        self.assertEqual(state["error"], "failed")
        self.assertEqual(state["status"], "unknown")
        self.assertIsNotNone(state["checked_at"])

        clock.now += 1
        with self.assertRaises(RuntimeError):
            checker.state()
        self.assertEqual(fetch.calls, 2)


if __name__ == "__main__":
    unittest.main()
