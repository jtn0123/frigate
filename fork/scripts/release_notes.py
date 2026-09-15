#!/usr/bin/env python3
"""Release notes for a fork build, generated from the fork's own commits.

Only commits the fork adds on top of upstream count, so a rebase onto newer
upstream never floods the notes with upstream work. Notes since a previous
release leave out the commits it had, matched by patch ID rather than SHA,
which survives those rebases, or by author, author date and subject, which
survive a conflict edit that changes the patch. A new commit that reuses an
old subject ("Fix lint") is still listed.

Each subject's ledger ID (`UI6: ...`) picks the section and is then dropped.
Commits that only touch files the image never ships (tests, CI, docs, fork
tooling), and the grade-report categories that never change what a user sees,
are counted but not listed. Lines about tooling (tests, lint, type checks, CI)
go last, folded under "Under the hood". A commit can override its line with a
`Release-note: <text>` trailer, or hide itself with `Release-note: none`.

    fork/scripts/release_notes.py [--ref HEAD] [--previous <tag>] [--image <ref>]

The last line is a `<!-- fork-build: <sha> -->` marker that the running app
uses to find its own release (frigate/fork/updates.py).
"""

import argparse
import fnmatch
import re
import subprocess
import sys
from dataclasses import dataclass, field

# Files that never reach the image, or only shape how the fork is developed.
INTERNAL_PATTERNS = (
    "fork/*",
    "*.md",
    "docs/*",
    ".github/*",
    "web/e2e/*",
    "web/__test__/*",
    "*.test.ts",
    "*.test.tsx",
    "frigate/test/*",
    "Makefile",
    ".pre-commit-config.yaml",
    ".gitignore",
    "web/eslint.config.js",
    "web/tsconfig*.json",
    "web/.env.example",
    "frigate/mypy.ini",
    "pyproject.toml",
    "generate_*.py",
)

# Grade-report categories that never change what a user sees: architecture,
# docs, developer tooling, and fork scaffolding.
INTERNAL_IDS = {"A", "H", "I", "S"}

SECTIONS = ("New", "Fixes and improvements", "Security", "Dependencies")

# Lines about how the fork is built and tested rather than what it does. They
# go last, folded, under this heading.
UNDER_THE_HOOD = "Under the hood"
TOOLING_RE = re.compile(
    r"\b(ratchet|typecheck|lint|eslint|prettier|playwright|vitest|jsdom|coverage"
    r"|sonar|ci|unit tests?|e2e|mypy|ruff|tailwind|promises?|node \d+)\b",
    re.IGNORECASE,
)

ID_RE = re.compile(
    r"^(?P<ids>[A-Z]{1,2}\d+(?:\s*\+\s*[A-Z]{1,2}\d+)*)\s*:\s*(?P<text>.+)$"
)
RECORD_SEP = "\x1e"


@dataclass
class Commit:
    subject: str
    trailer: str
    files: list[str]
    # `git patch-id --stable`, empty for a commit without a diff.
    patch_id: str = ""
    # Author email, author date and subject: what a rebase or cherry-pick
    # keeps even when a conflict edit changes the patch.
    identity: tuple[str, str, str] = ("", "", "")


@dataclass
class Notes:
    sha: str
    upstream: str
    previous_upstream: str | None
    first: bool
    sections: dict[str, list[str]] = field(default_factory=dict)
    internal: int = 0
    # Commits left out because the previous release had them.
    released: int = 0


def git(*args: str, cwd: str | None = None) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, cwd=cwd
    ).stdout


def revision_range(value: str) -> str:
    """Refuse a revision range git would read as an option (argument injection)."""
    if not value or value.startswith("-"):
        raise ValueError(f"not a revision range: {value!r}")
    return value


def patch_ids(rev_range: str, cwd: str | None = None) -> dict[str, str]:
    """SHA to stable patch ID for each non-merge commit with a diff in range."""
    # Bytes, not text: a diff can hold content that is not valid UTF-8.
    # The range goes in on stdin, never on the command line, so a value from
    # --previous or --ref cannot become a git option.
    log = subprocess.run(
        ["git", "log", "--no-merges", "-p", "--no-color", "--no-ext-diff"]
        + ["--format=commit %H", "--stdin"],
        input=f"{revision_range(rev_range)}\n".encode(),
        check=True,
        capture_output=True,
        cwd=cwd,
    ).stdout
    out = subprocess.run(
        ["git", "patch-id", "--stable"],
        input=log,
        check=True,
        capture_output=True,
        cwd=cwd,
    ).stdout.decode()
    ids = {}
    for line in out.splitlines():
        patch_id, sha = line.split()
        ids[sha] = patch_id
    return ids


def fork_commits(ref: str, upstream: str, cwd: str | None = None) -> list[Commit]:
    """Non-merge commits on `ref` that are not in `upstream`, oldest first."""
    base = git("merge-base", ref, upstream, cwd=cwd).strip()
    out = git(
        "log",
        "--no-merges",
        "--reverse",
        f"--format={RECORD_SEP}%H%x1f%ae%x1f%at%n%s%n"
        "%(trailers:key=Release-note,valueonly,separator=%x1f)",
        "--name-only",
        f"{base}..{ref}",
        cwd=cwd,
    )
    ids = patch_ids(f"{base}..{ref}", cwd)
    commits = []
    for record in out.split(RECORD_SEP)[1:]:
        lines = record.strip("\n").split("\n")
        sha, email, date = lines[0].split("\x1f")
        subject = lines[1]
        commits.append(
            Commit(
                subject=subject,
                trailer=lines[2].strip() if len(lines) > 2 else "",
                files=[f for f in lines[3:] if f],
                patch_id=ids.get(sha, ""),
                identity=(email, date, subject),
            )
        )
    return commits


def upstream_label(ref: str, upstream: str, cwd: str | None = None) -> str:
    """The upstream tag `ref` is based on, with a `-N-g<sha>` suffix past it."""
    base = git("merge-base", ref, upstream, cwd=cwd).strip()
    return git("describe", "--tags", "--match", "v*", base, cwd=cwd).strip()


def ledger_prefix(subject: str) -> tuple[str, str]:
    """Split `UI6 + C2: text` into ("UI", "text"); no ID gives ("", subject)."""
    match = ID_RE.match(subject)
    if match is None:
        return "", subject
    letters = re.match(r"[A-Z]+", match.group("ids"))
    return (letters.group(0) if letters else ""), match.group("text")


def is_internal(commit: Commit, prefix: str) -> bool:
    only_internal_files = bool(commit.files) and all(
        any(fnmatch.fnmatch(f, p) for p in INTERNAL_PATTERNS) for f in commit.files
    )
    return (
        only_internal_files
        or prefix in INTERNAL_IDS
        or commit.subject.lower().startswith("fork:")
    )


def section_for(prefix: str) -> str:
    if prefix in ("UI", "T"):
        return "New"
    if prefix == "E":
        return "Security"
    if prefix == "F":
        return "Dependencies"
    return "Fixes and improvements"


def build(
    ref: str, previous: str | None, upstream: str, cwd: str | None = None
) -> Notes:
    released_patches: set[str] = set()
    released_identities: set[tuple[str, str, str]] = set()
    previous_upstream = None
    if previous:
        for commit in fork_commits(previous, upstream, cwd):
            if commit.patch_id:
                released_patches.add(commit.patch_id)
            released_identities.add(commit.identity)
        previous_upstream = upstream_label(previous, upstream, cwd)

    notes = Notes(
        sha=git("rev-parse", ref, cwd=cwd).strip(),
        upstream=upstream_label(ref, upstream, cwd),
        previous_upstream=previous_upstream,
        first=previous is None,
    )
    for commit in fork_commits(ref, upstream, cwd):
        if commit.patch_id in released_patches or (
            commit.identity in released_identities
        ):
            notes.released += 1
            continue
        prefix, text = ledger_prefix(commit.subject)
        if commit.trailer.lower() == "none" or (
            not commit.trailer and is_internal(commit, prefix)
        ):
            notes.internal += 1
            continue
        line = commit.trailer or text
        line = line[0].upper() + line[1:].rstrip(".")
        section = section_for(prefix)
        # A Release-note: trailer is written for users, so it is never folded.
        if not commit.trailer and TOOLING_RE.search(line):
            section = UNDER_THE_HOOD
        items = notes.sections.setdefault(section, [])
        if line not in items:
            items.append(line)
    return notes


def to_markdown(notes: Notes, image: str | None = None) -> str:
    if notes.first:
        out = [f"First fork release, based on upstream `{notes.upstream}`."]
    elif notes.previous_upstream and notes.previous_upstream != notes.upstream:
        out = [
            f"Rebased onto upstream `{notes.upstream}`"
            f" (was `{notes.previous_upstream}`)."
        ]
    else:
        out = [f"Based on upstream `{notes.upstream}`."]

    for name in SECTIONS:
        items = notes.sections.get(name)
        if items:
            out.append(f"\n### {name}\n")
            out.extend(f"- {item}" for item in items)
    if not any(notes.sections.get(name) for name in SECTIONS):
        out.append("\nNo user-facing changes.")
    if notes.internal:
        plural = "change" if notes.internal == 1 else "changes"
        out.append(
            f"\n_{notes.internal} internal {plural} (tests, CI, docs, tooling)"
            " not listed._"
        )
    if image:
        out.append(f"\nImage: `{image}`")
    hood = notes.sections.get(UNDER_THE_HOOD)
    if hood:
        # <details> folds the list on GitHub; the app turns the summary into a
        # heading and folds it itself (frigate/fork/updates.py).
        out.append(f"\n<details>\n<summary>{UNDER_THE_HOOD} ({len(hood)})</summary>\n")
        out.extend(f"- {item}" for item in hood)
        out.append("\n</details>")
    out.append(f"\n<!-- fork-build: {notes.sha} -->")
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--ref", default="HEAD", help="commit to describe")
    parser.add_argument("--previous", help="previous release tag; omit for the first")
    parser.add_argument(
        "--upstream", default="origin/dev", help="upstream mirror branch"
    )
    parser.add_argument("--image", help="image reference to print at the end")
    args = parser.parse_args()
    notes = build(args.ref, args.previous, args.upstream)
    if args.previous:
        # The build log shows this; the notes themselves only cover new work.
        print(
            f"{notes.released} commit(s) already in {args.previous} left out",
            file=sys.stderr,
        )
    print(to_markdown(notes, args.image))


if __name__ == "__main__":
    main()
