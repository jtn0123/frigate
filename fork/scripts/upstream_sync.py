"""Helpers for "Fork - Upstream sync" (.github/workflows/fork-upstream-sync.yml).

The workflow used to rebase next onto upstream/dev. next carries hundreds of
fork commits on upstream files plus hand ports of upstream pull requests, so
that rebase stopped at the first fork commit that touched a file upstream had
also changed (G3, issue #91) and never got further (I72). dev is now a pure
mirror, and instead of a rebase this script describes where next stands:

    python3 fork/scripts/upstream_sync.py token
    python3 fork/scripts/upstream_sync.py report --next origin/next \\
        --upstream upstream/dev --body "$RUNNER_TEMP/body.md"

`token` checks the FORK_SYNC_TOKEN secret before anything uses it. An empty
secret, one GitHub rejects (expired or revoked) and one without access to the
repository each end the job with an error that names the cause, and a valid
token that expires within 14 days is a warning. The token is only sent to the
GitHub API and is never printed.

`report` lists the upstream commits next lacks, sorted into those next already
has (cherry-picked with -x, or patch-identical), those whose upstream pull
request next's commits or ledger cite, translations, and the rest, each tried
as a cherry-pick onto next with `git merge-tree`. It also tries the whole merge
of upstream/dev into next, and writes the conflicted files, or the merged tree
when there are none, for the workflow to report or push.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

WARN_DAYS = 14
# GitHub rejects an issue body over 65536 characters; leave room for edits.
BODY_LIMIT = 60000
ROTATE = (
    "Create a new fine-grained token for {repo} with Contents: Read and write "
    "and Workflows: Read and write, save it as the Actions repository secret "
    "FORK_SYNC_TOKEN, then run the workflow again (steps: fork/README.md, "
    "Owner setup)"
)

_TRANSLATION = re.compile(
    r"^(Translated using Weblate|Update translation files|"
    r"Translations update from Hosted Weblate|"
    r"(Added|Deleted|Removed) translation using Weblate)\b"
)
_PR_SUFFIX = re.compile(r"\(#(\d+)\)\s*$")
_CHERRY = re.compile(r"cherry picked from commit ([0-9a-f]{7,40})")
# Upstream pull requests have five or more digits; the fork's have fewer, so
# its own "#155" never reads as an upstream number.
_UPSTREAM_PR = re.compile(r"#(\d{5,})\b")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

Runner = Callable[[Sequence[str]], tuple[int, str]]


@dataclass(frozen=True)
class TokenCheck:
    """What the token probe found."""

    state: str
    level: str
    message: str
    expires: str = ""

    @property
    def fatal(self) -> bool:
        """Whether the job has to stop here."""
        return self.level == "error"


def classify_token(
    repo: str, status: int | None, expiration: str | None, today: date
) -> TokenCheck:
    """Turn the GitHub API's answer to the token into a verdict.

    Args:
        repo: owner/name of the repository the token must reach
        status: HTTP status of GET /repos/{repo}, or None when unreachable
        expiration: The github-authentication-token-expiration header
        today: The current date

    Returns:
        The verdict; level is "error" when the sync cannot run
    """
    rotate = ROTATE.format(repo=repo)
    if status == 401:
        return TokenCheck(
            "expired",
            "error",
            f"GitHub rejected FORK_SYNC_TOKEN (401): it has expired or was "
            f"revoked. {rotate}",
        )
    if status in (403, 404):
        return TokenCheck(
            "no_access",
            "error",
            f"FORK_SYNC_TOKEN cannot read {repo} (HTTP {status}): the token "
            f"does not include this repository. {rotate}",
        )
    if status != 200:
        return TokenCheck(
            "unknown",
            "warning",
            f"Could not verify FORK_SYNC_TOKEN (HTTP {status or 'unreachable'}); "
            "continuing, the checkout will fail if the token is bad",
        )
    match = _DATE.search(expiration or "")
    if match is None:
        return TokenCheck("valid", "notice", "FORK_SYNC_TOKEN works and never expires")
    expires = date.fromisoformat(match.group(0))
    left = (expires - today).days
    if left <= WARN_DAYS:
        return TokenCheck(
            "expiring",
            "warning",
            f"FORK_SYNC_TOKEN expires on {expires.isoformat()}, in {left} "
            f"day(s). {rotate}",
            expires.isoformat(),
        )
    return TokenCheck(
        "valid",
        "notice",
        f"FORK_SYNC_TOKEN works and expires on {expires.isoformat()}",
        expires.isoformat(),
    )


def probe_token(token: str, repo: str) -> tuple[int | None, str | None]:
    """Ask the GitHub API for the repository with the token.

    Args:
        token: The FORK_SYNC_TOKEN value
        repo: owner/name

    Returns:
        The HTTP status (None when GitHub could not be reached) and the
        token expiration header
    """
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.headers.get(
                "github-authentication-token-expiration"
            )
    except urllib.error.HTTPError as err:
        return err.code, None
    except (urllib.error.URLError, TimeoutError):
        return None, None


@dataclass(frozen=True)
class Commit:
    """One upstream commit."""

    sha: str
    subject: str

    @property
    def pr(self) -> str | None:
        """The upstream pull request number from a squash-merge subject."""
        match = _PR_SUFFIX.search(self.subject)
        return match.group(1) if match else None


@dataclass
class Report:
    """Where next stands against upstream."""

    upstream: str
    commits: list[Commit] = field(default_factory=list)
    in_next: list[Commit] = field(default_factory=list)
    cited: list[Commit] = field(default_factory=list)
    translations: list[Commit] = field(default_factory=list)
    clean: list[Commit] = field(default_factory=list)
    conflicting: list[tuple[Commit, list[str]]] = field(default_factory=list)
    merge_tree: str = ""
    merge_conflicts: list[str] = field(default_factory=list)


def is_translation(subject: str) -> bool:
    """Whether a subject is one of Weblate's translation commits."""
    return _TRANSLATION.match(subject) is not None


def parse_log(text: str) -> list[Commit]:
    """Parse `git log --format=%H%x00%s` output, newest first, into commits."""
    commits = []
    for line in text.splitlines():
        sha, sep, subject = line.partition("\0")
        if sep:
            commits.append(Commit(sha.strip(), subject))
    return commits


def cited_refs(texts: Iterable[str]) -> tuple[set[str], set[str]]:
    """Collect what next's commit messages and ledger say they took.

    Args:
        texts: Commit messages and ledger rows

    Returns:
        The cherry-picked SHAs and the five-digit pull request numbers
    """
    shas: set[str] = set()
    prs: set[str] = set()
    for text in texts:
        shas.update(_CHERRY.findall(text))
        prs.update(_UPSTREAM_PR.findall(text))
    return shas, prs


def parse_merge_tree(rc: int, output: str) -> tuple[str, list[str]]:
    """Read `git merge-tree --write-tree --name-only --no-messages` output.

    Args:
        rc: Its exit code, 0 for a clean merge and 1 for conflicts
        output: Its standard output

    Returns:
        The merged tree when clean (else ""), and the conflicted files

    Raises:
        RuntimeError: If git failed rather than reporting a result
    """
    if rc not in (0, 1):
        raise RuntimeError(f"git merge-tree failed ({rc}): {output.strip()}")
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("git merge-tree printed no tree")
    if rc == 0:
        return lines[0].strip(), []
    return "", sorted(dict.fromkeys(line.strip() for line in lines[1:]))


def _was_taken(commit: Commit, taken: set[str]) -> bool:
    return any(commit.sha.startswith(sha) for sha in taken)


def build_report(run: Runner, next_ref: str, upstream_ref: str) -> Report:
    """Sort the upstream commits next lacks and try the merge.

    Args:
        run: Runs git with the given arguments and returns (rc, stdout)
        next_ref: The fork's integration branch, such as origin/next
        upstream_ref: The upstream branch, such as upstream/dev

    Returns:
        The report
    """
    rc, head = run(["rev-parse", upstream_ref])
    report = Report(upstream=head.strip() if rc == 0 else upstream_ref)
    _, log = run(
        ["log", "--no-merges", "--format=%H%x00%s", f"{next_ref}..{upstream_ref}"]
    )
    report.commits = parse_log(log)
    if not report.commits:
        return report

    # "-" marks an upstream commit whose patch next already has.
    _, cherry = run(["cherry", next_ref, upstream_ref])
    equivalent = {
        line[2:].strip() for line in cherry.splitlines() if line.startswith("- ")
    }
    _, base = run(["merge-base", next_ref, upstream_ref])
    _, messages = run(["log", "--format=%B%x00", f"{base.strip()}..{next_ref}"])
    _, ledger = run(
        ["grep", "-h", "-e", "#[0-9]", next_ref, "--", "FORK.md", "fork/ledger"]
    )
    taken, prs = cited_refs([messages, ledger])

    for commit in reversed(report.commits):
        if commit.sha in equivalent or _was_taken(commit, taken):
            report.in_next.append(commit)
        elif commit.pr is not None and commit.pr in prs:
            report.cited.append(commit)
        elif is_translation(commit.subject):
            report.translations.append(commit)
        else:
            rc, out = run(
                [
                    "merge-tree",
                    "--write-tree",
                    "--name-only",
                    "--no-messages",
                    f"--merge-base={commit.sha}^",
                    next_ref,
                    commit.sha,
                ]
            )
            _, files = parse_merge_tree(rc, out)
            if files:
                report.conflicting.append((commit, files))
            else:
                report.clean.append(commit)

    rc, out = run(
        [
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            next_ref,
            upstream_ref,
        ]
    )
    report.merge_tree, report.merge_conflicts = parse_merge_tree(rc, out)
    return report


def _bullets(items: Sequence[str], limit: int) -> str:
    shown = [f"- {item}" for item in items[:limit]]
    if len(items) > limit:
        shown.append(f"- ... and {len(items) - limit} more")
    return "\n".join(shown)


def _line(commit: Commit) -> str:
    return f"{commit.sha[:9]} {commit.subject}"


def render_body(report: Report, limit: int = 400) -> str:
    """Write the sync issue's body, with each list cut to `limit` entries."""
    total = len(report.commits)
    rows = [
        (
            "Already in next (cherry-picked with -x, or patch-identical)",
            len(report.in_next),
        ),
        (
            "Upstream PR cited by next's commits or ledger (hand ports)",
            len(report.cited),
        ),
        ("Translations (Weblate)", len(report.translations)),
        ("Apply cleanly to next as a cherry-pick", len(report.clean)),
        ("Conflict with next as a cherry-pick", len(report.conflicting)),
    ]
    parts = [
        f"upstream/dev ({report.upstream}) has {total} commit(s), merges not "
        "counted, that next does not contain. dev mirrors upstream; this bot "
        "never rebases or pushes next, main or tags, and upstream work reaches "
        "next as reviewed ports (cherry-pick -x, one ledger ID per batch).",
        "| Upstream commits | Count |\n|---|---|\n"
        + "\n".join(f"| {label} | {count} |" for label, count in rows),
    ]
    if report.merge_conflicts:
        parts.append(
            f"Merging upstream/dev into next conflicts in "
            f"{len(report.merge_conflicts)} file(s).\n\n"
            "<details><summary>Conflicted files</summary>\n\n"
            + _bullets(report.merge_conflicts, limit)
            + "\n\n</details>"
        )
    else:
        parts.append(
            "Merging upstream/dev into next is clean. The merge is on "
            "sync/upstream, where Fork - Checks runs."
        )
    if report.clean:
        parts.append(
            "### Apply cleanly (port candidates)\n\n"
            + _bullets([_line(c) for c in report.clean], limit)
        )
    if report.conflicting:
        items = []
        for commit, files in report.conflicting:
            shown = ", ".join(files[:5]) + (", ..." if len(files) > 5 else "")
            items.append(f"{_line(commit)}: {shown}")
        parts.append("### Conflict with next\n\n" + _bullets(items, limit))
    if report.cited:
        parts.append(
            "### Cited by next (check the port is complete)\n\n"
            + _bullets([_line(c) for c in report.cited], limit)
        )
    return "\n\n".join(parts) + "\n"


def fit_body(report: Report, budget: int = BODY_LIMIT) -> str:
    """Render the body, shortening the lists until it fits GitHub's limit."""
    for limit in (400, 200, 100, 50, 20, 5, 0):
        body = render_body(report, limit)
        if len(body) <= budget:
            return body
    return body[: budget - 20] + "\n\n(truncated)\n"


def _git(args: Sequence[str]) -> tuple[int, str]:
    result = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
    return result.returncode, result.stdout


def _output(values: dict[str, str]) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as out:
        for key, value in values.items():
            out.write(f"{key}={value}\n")


def main_token(today: date | None = None) -> int:
    """Check FORK_SYNC_TOKEN and annotate the run; 1 when the sync cannot run."""
    repo = os.environ.get("GITHUB_REPOSITORY", "jtn0123/frigate")
    token = os.environ.get("FORK_SYNC_TOKEN", "")
    if not token:
        check = TokenCheck(
            "missing",
            "error",
            f"The Actions repository secret FORK_SYNC_TOKEN does not exist or "
            f"is empty. {ROTATE.format(repo=repo)}",
        )
    else:
        status, expiration = probe_token(token, repo)
        check = classify_token(repo, status, expiration, today or date.today())
    print(f"::{check.level} title=FORK_SYNC_TOKEN {check.state}::{check.message}")
    _output({"state": check.state, "expires": check.expires})
    return 1 if check.fatal else 0


def main_report(args: argparse.Namespace) -> int:
    """Write the sync issue body and the merge result for the workflow."""
    report = build_report(_git, args.next, args.upstream)
    Path(args.body).write_text(fit_body(report), encoding="utf-8")
    print(
        json.dumps(
            {
                "missing": len(report.commits),
                "in_next": len(report.in_next),
                "cited": len(report.cited),
                "translations": len(report.translations),
                "clean": len(report.clean),
                "conflicting": len(report.conflicting),
                "merge_conflicts": len(report.merge_conflicts),
            }
        )
    )
    _output(
        {
            "missing": str(len(report.commits)),
            "merge_tree": report.merge_tree,
            "merge_conflicts": str(len(report.merge_conflicts)),
        }
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Command line entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("token", help="check the FORK_SYNC_TOKEN secret")
    report = sub.add_parser("report", help="describe next against upstream")
    report.add_argument("--next", default="origin/next")
    report.add_argument("--upstream", default="upstream/dev")
    report.add_argument("--body", required=True, help="where to write the issue body")
    args = parser.parse_args(argv)
    if args.command == "token":
        return main_token()
    return main_report(args)


if __name__ == "__main__":
    sys.exit(main())
