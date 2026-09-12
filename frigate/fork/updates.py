"""Update notices from this fork's GitHub releases.

"Fork - Build image" publishes a release for every image built from `main`,
and each release body ends with a `<!-- fork-build: <sha> -->` marker
(fork/scripts/release_notes.py). `make version` puts the build's short SHA at
the end of VERSION, so finding that SHA among the releases tells which ones
are newer than the running build without parsing any version numbers.

Only the fork's repository is checked. Tracking upstream is left to the
"Fork - Upstream sync" workflow, which files an issue per upstream release.
"""

import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any

import requests
from requests.exceptions import RequestException

from frigate.version import VERSION

logger = logging.getLogger(__name__)

FORK_REPO = "jtn0123/frigate"
RELEASES_URL = f"https://api.github.com/repos/{FORK_REPO}/releases?per_page=30"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{FORK_REPO}/releases/latest"

CHECK_INTERVAL_SECONDS = 6 * 60 * 60
# "Check now" refetches at most this often, well under GitHub's limit of 60
# unauthenticated requests per hour.
MIN_REFRESH_SECONDS = 60

BUILD_MARKER = re.compile(r"<!--\s*fork-build:\s*([0-9a-f]{7,40})\s*-->")
VERSION_SHA = re.compile(r"-([0-9a-f]{7,40})$")


@dataclass(frozen=True)
class ForkRelease:
    tag: str
    name: str
    sha: str
    published_at: str
    url: str
    notes: str


def parse_release(raw: dict[str, Any]) -> ForkRelease | None:
    """A published fork release, or None for drafts, pre-releases and
    releases without a build marker."""
    if raw.get("draft") or raw.get("prerelease"):
        return None
    body = str(raw.get("body") or "")
    marker = BUILD_MARKER.search(body)
    if marker is None:
        return None
    tag = str(raw.get("tag_name") or "")
    return ForkRelease(
        tag=tag,
        name=str(raw.get("name") or tag.removeprefix("fork/")),
        sha=marker.group(1),
        published_at=str(raw.get("published_at") or ""),
        url=str(raw.get("html_url") or ""),
        notes=BUILD_MARKER.sub("", body).strip(),
    )


def build_sha(version: str) -> str | None:
    """The commit `make version` appended to VERSION, if any."""
    match = VERSION_SHA.search(version)
    return match.group(1) if match else None


def same_commit(a: str, b: str) -> bool:
    shortest = min(len(a), len(b))
    return shortest >= 7 and a[:shortest] == b[:shortest]


def summarize(
    version: str,
    releases: list[ForkRelease],
    checked_at: float | None,
    error: str | None,
) -> dict[str, Any]:
    """The state the web UI renders. `releases` is newest first."""
    sha = build_sha(version)
    index = next(
        (i for i, r in enumerate(releases) if sha and same_commit(r.sha, sha)),
        None,
    )
    if index is None:
        # A local build, or a release too old to be in the fetched page.
        status = "unknown" if error and not releases else "development"
    else:
        status = "up-to-date" if index == 0 else "available"

    return {
        "status": status,
        "repo": FORK_REPO,
        "current_version": version,
        "current_sha": sha,
        "current_tag": releases[index].tag if index is not None else None,
        "latest_tag": releases[0].tag if releases else None,
        "newer_count": index or 0,
        "releases": [asdict(r) for r in releases],
        "checked_at": checked_at,
        "error": error,
    }


def fetch_releases() -> list[dict[str, Any]]:
    response = requests.get(
        RELEASES_URL,
        timeout=10,
        headers={"Accept": "application/vnd.github+json"},
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise ValueError("GitHub releases response is not a list")
    return data


class ForkUpdateChecker:
    """Caches the fork's releases and refreshes them every few hours."""

    def __init__(
        self,
        version: str,
        fetch: Callable[[], list[dict[str, Any]]] = fetch_releases,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._version = version
        self._fetch = fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._releases: list[ForkRelease] = []
        self._checked_at: float | None = None
        self._error: str | None = None

    def state(self, force: bool = False) -> dict[str, Any]:
        """Current update state, refetching when stale or when forced."""
        with self._lock:
            now = self._clock()
            age = None if self._checked_at is None else now - self._checked_at
            if (
                age is None
                or age >= CHECK_INTERVAL_SECONDS
                or (force and age >= MIN_REFRESH_SECONDS)
            ):
                self._refresh(now)
            return summarize(
                self._version, self._releases, self._checked_at, self._error
            )

    def _refresh(self, now: float) -> None:
        try:
            raw = self._fetch()
        except (RequestException, ValueError) as err:
            logger.debug("Fork update check failed: %s", err)
            self._error = "unreachable"
        else:
            parsed = (parse_release(item) for item in raw if isinstance(item, dict))
            self._releases = [r for r in parsed if r is not None]
            self._error = None
        self._checked_at = now


_checker: ForkUpdateChecker | None = None


def get_checker() -> ForkUpdateChecker:
    global _checker
    if _checker is None:
        _checker = ForkUpdateChecker(VERSION)
    return _checker
