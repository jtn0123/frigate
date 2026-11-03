#!/usr/bin/env python3
"""Print the tag of the newest published server release, or nothing.

promote.sh and "Fork - Build image" pass it to release_notes.py as
--previous. Only fork/<version> tags are server releases: the repository also
carries android-v* releases of the viewer app, and taking the newest release of
any kind would compute the server's notes from an Android tag (I76).

    fork/scripts/previous_release.py [--repo jtn0123/frigate]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Callable, Iterable
from typing import Any

SERVER_TAG_PREFIX = "fork/"
# gh lists newest first; the newest server release is well within this many.
LIST_LIMIT = 100


def newest_server_release(releases: Iterable[dict[str, Any]]) -> str | None:
    """The first published, non-prerelease fork/* tag of a newest-first list."""
    for release in releases:
        tag = release.get("tagName")
        if (
            isinstance(tag, str)
            and tag.startswith(SERVER_TAG_PREFIX)
            and not release.get("isDraft")
            and not release.get("isPrerelease")
        ):
            return tag
    return None


def list_releases(repo: str) -> list[dict[str, Any]]:
    """Releases of repo from gh, newest first."""
    result = subprocess.run(
        [
            "gh",
            "release",
            "list",
            "-R",
            repo,
            "--limit",
            str(LIST_LIMIT),
            "--json",
            "tagName,isDraft,isPrerelease",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    releases = json.loads(result.stdout or "[]")
    if not isinstance(releases, list):
        raise ValueError("gh release list did not return a list")
    return releases


def main(
    argv: list[str] | None = None,
    fetch: Callable[[str], list[dict[str, Any]]] = list_releases,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default="jtn0123/frigate")
    args = parser.parse_args(argv)
    tag = newest_server_release(fetch(args.repo))
    if tag:
        print(tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
