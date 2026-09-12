#!/usr/bin/env python3
"""Release notes for a fork build, generated from the fork's own commits.

Only commits the fork adds on top of upstream count, so a rebase onto newer
upstream never floods the notes with upstream work. Notes since a previous
release match commit subjects rather than SHAs, which survives those rebases.

Each subject's ledger ID (`UI6: ...`) picks the section and is then dropped.
Commits that only touch files the image never ships (tests, CI, docs, fork
tooling), and the grade-report categories that never change what a user sees,
are counted but not listed. A commit can override its line with a
`Release-note: <text>` trailer, or hide itself with `Release-note: none`.

    fork/scripts/release_notes.py [--ref HEAD] [--previous <tag>] [--image <ref>]

The last line is a `<!-- fork-build: <sha> -->` marker that the running app
uses to find its own release (frigate/fork/updates.py).
"""

import argparse
import fnmatch
import re
import subprocess
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

ID_RE = re.compile(
    r"^(?P<ids>[A-Z]{1,2}\d+(?:\s*\+\s*[A-Z]{1,2}\d+)*)\s*:\s*(?P<text>.+)$"
)
RECORD_SEP = "\x1e"


@dataclass
class Commit:
    subject: str
    trailer: str
    files: list[str]


@dataclass
class Notes:
    sha: str
    upstream: str
    previous_upstream: str | None
    first: bool
    sections: dict[str, list[str]] = field(default_factory=dict)
    internal: int = 0


def git(*args: str, cwd: str | None = None) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, cwd=cwd
    ).stdout


def fork_commits(ref: str, upstream: str, cwd: str | None = None) -> list[Commit]:
    """Non-merge commits on `ref` that are not in `upstream`, oldest first."""
    base = git("merge-base", ref, upstream, cwd=cwd).strip()
    out = git(
        "log",
        "--no-merges",
        "--reverse",
        f"--format={RECORD_SEP}%s%n%(trailers:key=Release-note,valueonly,separator=%x1f)",
        "--name-only",
        f"{base}..{ref}",
        cwd=cwd,
    )
    commits = []
    for record in out.split(RECORD_SEP)[1:]:
        lines = record.strip("\n").split("\n")
        commits.append(
            Commit(
                subject=lines[0],
                trailer=lines[1].strip() if len(lines) > 1 else "",
                files=[f for f in lines[2:] if f],
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
    seen: set[str] = set()
    previous_upstream = None
    if previous:
        seen = {c.subject for c in fork_commits(previous, upstream, cwd)}
        previous_upstream = upstream_label(previous, upstream, cwd)

    notes = Notes(
        sha=git("rev-parse", ref, cwd=cwd).strip(),
        upstream=upstream_label(ref, upstream, cwd),
        previous_upstream=previous_upstream,
        first=previous is None,
    )
    for commit in fork_commits(ref, upstream, cwd):
        if commit.subject in seen:
            continue
        prefix, text = ledger_prefix(commit.subject)
        if commit.trailer.lower() == "none" or (
            not commit.trailer and is_internal(commit, prefix)
        ):
            notes.internal += 1
            continue
        line = commit.trailer or text
        line = line[0].upper() + line[1:]
        items = notes.sections.setdefault(section_for(prefix), [])
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
    if not notes.sections:
        out.append("\nNo user-facing changes.")
    if notes.internal:
        plural = "change" if notes.internal == 1 else "changes"
        out.append(
            f"\n_{notes.internal} internal {plural} (tests, CI, docs, tooling)"
            " not listed._"
        )
    if image:
        out.append(f"\nImage: `{image}`")
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
    print(to_markdown(build(args.ref, args.previous, args.upstream), args.image))


if __name__ == "__main__":
    main()
