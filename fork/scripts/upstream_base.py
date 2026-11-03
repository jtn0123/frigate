#!/usr/bin/env python3
"""Print the upstream release a ref is based on.

next takes upstream work as reviewed ports (cherry-pick -x), never by merging
upstream's history, so `git describe` of next's merge base with upstream stays
on the release next forked from (v0.18.0) after every 0.18.x fix has been
ported. fork/upstream-base names the newest upstream release whose commits next
has in full; it is moved once the "Upstream moved" issue lists none of that
release's commits as missing. The label is the newer of the two (I78).

    fork/scripts/upstream_base.py [--ref HEAD] [--upstream origin/dev] [--tag]

--tag prints the release tag alone, without describe's `-N-g<sha>` suffix.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

BASE_FILE = "fork/upstream-base"
RELEASE_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)")
CLAIM_RE = re.compile(r"^v\d+\.\d+\.\d+$")


def git(*args: str, cwd: str | None = None) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, cwd=cwd
    ).stdout


def release(label: str) -> tuple[int, int, int] | None:
    """(major, minor, patch) of a v-label, or None when it is not one."""
    match = RELEASE_RE.match(label)
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return major, minor, patch


def parse_claim(text: str) -> str | None:
    """The release tag the file names; comments and blank lines are skipped."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if not CLAIM_RE.match(line):
            raise ValueError(f"{BASE_FILE}: not a vX.Y.Z release tag: {line!r}")
        return line
    return None


def claimed(ref: str, cwd: str | None = None) -> str | None:
    """The release fork/upstream-base names at ref, or None without the file."""
    try:
        text = git("show", f"{ref}:{BASE_FILE}", cwd=cwd)
    except subprocess.CalledProcessError:
        return None
    return parse_claim(text)


def described(ref: str, upstream: str, tag: bool, cwd: str | None = None) -> str:
    """git describe of ref's merge base with upstream."""
    base = git("merge-base", ref, upstream, cwd=cwd).strip()
    args = ["describe", "--tags", "--match", "v*"]
    if tag:
        args.append("--abbrev=0")
    return git(*args, base, cwd=cwd).strip()


def newer(described_label: str, claim: str | None) -> str:
    """The claim when it names a later release than the describe label."""
    wanted = release(claim) if claim is not None else None
    if claim is None or wanted is None:
        return described_label
    current = release(described_label)
    if current is not None and current >= wanted:
        return described_label
    return claim


def label(ref: str, upstream: str, tag: bool = False, cwd: str | None = None) -> str:
    """The upstream release ref is based on, by history or by fork/upstream-base."""
    return newer(described(ref, upstream, tag, cwd), claimed(ref, cwd))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--upstream", default="origin/dev")
    parser.add_argument("--tag", action="store_true", help="omit the -N-g suffix")
    args = parser.parse_args(argv)
    print(label(args.ref, args.upstream, args.tag))
    return 0


if __name__ == "__main__":
    sys.exit(main())
