#!/usr/bin/env python3
"""Runs the fork's CI on this machine and reports it to GitHub (I163).

GitHub Actions can stop running for the repository (it did in November 2026),
and pull requests then cannot merge, because next requires "Checks passed".
This runs the same jobs here and posts their result to the commit as a
"Checks passed" status, which satisfies that rule (the rule accepts the status
from any source).

    fork/scripts/local_ci.py pr 252          # one pull request
    fork/scripts/local_ci.py ref next        # a branch head, every job
    fork/scripts/local_ci.py watch           # every open pull request, then poll
    fork/scripts/local_ci.py pr 252 --no-post   # run without reporting

A pull request is tested as CI tests it: its head merged into its base, in a
worktree of its own (frigate-wt/ci), with the jobs fork/scripts/ci-changes.sh
picks for the change. Those run through fork/scripts/check.sh --gates from
this checkout, so the gate list is always the current one. A change under
fork/android also runs the Android gate, and --device adds the instrumented
tests on a connected device or emulator. A push (ref) runs every job.

Not run here: the Sonar quality gate, which needs the owner's SONAR_TOKEN.
The status description says so.

Only branches of this repository are run. A pull request from another
repository's fork could run anything on this machine, so it is refused.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

CONTEXT = "Checks passed"
SCRIPTS = Path(__file__).resolve().parent
DOCKER_LOCK = "/tmp/frigate-docker.lock"
ANDROID_LOCK = "/tmp/frigate-android.lock"
ANDROID_RE = re.compile(r"^(fork/android/|\.github/workflows/fork-android\.yml$)")
# Every gate check.sh --gates knows, in the order CI's jobs list them.
ALL_GATES = (
    "gitleaks",
    "lint",
    "typecheck",
    "ratchet",
    "i18n",
    "build",
    "e2e",
    "vitest",
    "python",
    "ruff",
    "mypy_fork",
    "scripts",
    "locks",
    "runtime",
    "audio",
)
DOCKER_GATES = {"python", "runtime", "audio"}
# Pending statuses older than this are from a run that died.
STALE_PENDING_S = 4 * 3600
DESCRIPTION_MAX = 140


@dataclass(frozen=True)
class Target:
    """A commit to test and where its status goes."""

    label: str
    sha: str  # the commit the status is posted to
    base: str | None  # merged in before testing (a pull request's base)
    everything: bool  # run every job, as CI does for a push


class Refused(Exception):
    """The target must not run on this machine."""


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> str:
    """Runs a command and returns its stdout."""
    result = subprocess.run(cmd, cwd=cwd, check=check, capture_output=True, text=True)
    return result.stdout.strip()


def gates_for(areas: dict[str, bool], everything: bool) -> list[str]:
    """Maps ci-changes.sh's areas to check.sh gates, the way CI maps them to jobs.

    The secrets scan runs for every change, like CI's gitleaks job.
    """
    if everything:
        return list(ALL_GATES)
    wanted = {"gitleaks"}
    if areas.get("web"):
        wanted |= {"lint", "typecheck", "ratchet", "i18n", "build", "e2e"}
    if areas.get("coverage"):
        wanted |= {"vitest", "python"}
    if areas.get("python"):
        wanted |= {"ruff", "mypy_fork", "scripts", "locks"}
    if areas.get("backend"):
        wanted |= {"runtime", "audio"}
    return [gate for gate in ALL_GATES if gate in wanted]


def parse_areas(output: str) -> dict[str, bool]:
    """Reads ci-changes.sh's key=value lines."""
    areas: dict[str, bool] = {}
    for line in output.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            areas[key.strip()] = value.strip() == "true"
    return areas


def touches_android(files: list[str]) -> bool:
    """Whether the change needs the Android job (fork-android.yml's paths)."""
    return any(ANDROID_RE.match(name) for name in files)


def description(state: str, gates: list[str], android: bool) -> str:
    """The status line GitHub shows next to "Checks passed".

    It names no machine: the status is public, and host names carry user names.
    """
    jobs = len(gates) + (1 if android else 0)
    words = {
        "pending": f"Local CI: running {jobs} jobs",
        "success": f"Local CI: {jobs} jobs passed (Sonar not run)",
        "failure": f"Local CI: failed ({jobs} jobs run)",
    }
    return words.get(state, f"Local CI: {state}")[:DESCRIPTION_MAX]


def check_trusted(pr: dict[str, object], owner: str) -> None:
    """Refuses pull requests whose code comes from outside this repository."""
    if pr.get("isCrossRepository"):
        raise Refused(f"#{pr.get('number')} comes from another repository")
    head_owner = pr.get("headRepositoryOwner")
    login = head_owner.get("login") if isinstance(head_owner, dict) else None
    if login and login != owner:
        raise Refused(f"#{pr.get('number')} head belongs to {login}")
    if pr.get("baseRefName") not in ("next", "main"):
        raise Refused(f"#{pr.get('number')} does not target next or main")


def needs_run(statuses: list[dict[str, object]], now: float) -> bool:
    """Whether a commit has no settled "Checks passed" status yet.

    A pending one from a run that died (older than STALE_PENDING_S) does not
    count. GitHub lists a commit's statuses newest first.
    """
    for status in statuses:
        if status.get("context") != CONTEXT:
            continue
        if status.get("state") in ("success", "failure", "error"):
            return False
        updated = str(status.get("updated_at", ""))
        try:
            stamp = datetime.datetime.fromisoformat(updated.replace("Z", "+00:00"))
        except ValueError:
            return True
        return now - stamp.timestamp() > STALE_PENDING_S
    return True


def take(lock: str) -> None:
    """Waits for a lock directory and takes it (the fork's lock protocol)."""
    while True:
        try:
            os.mkdir(lock)
            return
        except FileExistsError:
            time.sleep(15)


class Runner:
    """Runs targets in the CI worktree and posts their statuses."""

    def __init__(self, post: bool, device: bool) -> None:
        self.post_enabled = post
        self.device = device
        self.repo_root = Path(run(["git", "rev-parse", "--show-toplevel"]))
        common = Path(
            run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
        )
        main = common.parent
        self.worktree = Path(
            os.environ.get("FORK_CI_WORKTREE", main.parent / "frigate-wt" / "ci")
        )
        self.home = Path(
            os.environ.get("FORK_CI_HOME", Path.home() / ".cache" / "frigate-ci")
        )
        self.repo = run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
            cwd=self.repo_root,
        )
        self.owner = self.repo.split("/")[0]

    # ---- GitHub ----

    def post(self, sha: str, state: str, text: str) -> None:
        """Posts the "Checks passed" status on a commit."""
        print(f"status {state}: {text}", flush=True)
        if not self.post_enabled:
            return
        run(
            [
                "gh",
                "api",
                "-X",
                "POST",
                f"repos/{self.repo}/statuses/{sha}",
                "-f",
                f"state={state}",
                "-f",
                f"context={CONTEXT}",
                "-f",
                f"description={text}",
            ]
        )

    def statuses(self, sha: str) -> list[dict[str, object]]:
        """The commit's statuses, newest first."""
        out = run(["gh", "api", f"repos/{self.repo}/commits/{sha}/statuses"])
        data = json.loads(out or "[]")
        return data if isinstance(data, list) else []

    def pr_target(self, number: int) -> Target:
        """Looks up an open pull request and checks it may run here."""
        fields = (
            "number,headRefOid,baseRefName,isCrossRepository,headRepositoryOwner,state"
        )
        pr = json.loads(
            run(
                ["gh", "pr", "view", str(number), "--repo", self.repo, "--json", fields]
            )
        )
        check_trusted(pr, self.owner)
        if pr.get("state") != "OPEN":
            raise Refused(f"#{number} is {str(pr.get('state')).lower()}")
        base = str(pr["baseRefName"])
        return Target(f"#{number}", str(pr["headRefOid"]), base, everything=False)

    def ref_target(self, ref: str) -> Target:
        """A branch head of this repository, tested whole as a push is."""
        self.fetch()
        sha = run(
            ["git", "rev-parse", f"refs/remotes/origin/{ref}"], cwd=self.repo_root
        )
        return Target(ref, sha, None, everything=True)

    def open_prs(self) -> list[dict[str, object]]:
        fields = "number,headRefOid,baseRefName,isCrossRepository,headRepositoryOwner"
        out = run(
            [
                "gh",
                "pr",
                "list",
                "--repo",
                self.repo,
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                fields,
            ]
        )
        data = json.loads(out or "[]")
        return data if isinstance(data, list) else []

    # ---- the worktree ----

    def fetch(self) -> None:
        run(["git", "fetch", "-q", "origin"], cwd=self.repo_root)

    def prepare(self, target: Target) -> bool:
        """Checks the target out in the CI worktree; False if it cannot merge."""
        self.fetch()
        run(
            ["git", "fetch", "-q", "origin", target.sha],
            cwd=self.repo_root,
            check=False,
        )
        if not (self.worktree / ".git").exists():
            self.worktree.parent.mkdir(parents=True, exist_ok=True)
            run(
                [
                    "git",
                    "worktree",
                    "add",
                    "-q",
                    "--detach",
                    str(self.worktree),
                    target.sha,
                ],
                cwd=self.repo_root,
            )
        git = ["git", "-c", "core.hooksPath=/dev/null"]
        run(git + ["merge", "--abort"], cwd=self.worktree, check=False)
        run(
            git + ["checkout", "-q", "--detach", "--force", target.sha],
            cwd=self.worktree,
        )
        # Keep the installed node_modules, the e2e port and Gradle's project cache.
        run(
            git
            + [
                "clean",
                "-q",
                "-ffdx",
                "-e",
                "web/node_modules",
                "-e",
                "web/.e2e-port",
                "-e",
                "fork/android/.gradle",
            ],
            cwd=self.worktree,
        )
        if target.base is None:
            return True
        merged = subprocess.run(
            git
            + [
                "-c",
                "user.name=local-ci",
                "-c",
                "user.email=local-ci@localhost",
                "merge",
                "-q",
                "--no-ff",
                "--no-edit",
                f"origin/{target.base}",
            ],
            cwd=self.worktree,
            capture_output=True,
            text=True,
        )
        if merged.returncode != 0:
            run(git + ["merge", "--abort"], cwd=self.worktree, check=False)
            return False
        return True

    def install_web(self, log: Path) -> int:
        """Runs npm ci when web/package-lock.json changed since the last install."""
        lock = self.worktree / "web" / "package-lock.json"
        digest = hashlib.sha256(lock.read_bytes()).hexdigest()
        stamp = self.worktree / "web" / "node_modules" / ".local-ci-lock"
        if stamp.exists() and stamp.read_text().strip() == digest:
            return 0
        rc = self.logged(
            ["npm", "ci", "--no-audit", "--no-fund"], log, cwd=self.worktree / "web"
        )
        if rc == 0:
            stamp.write_text(digest)
        return rc

    def python_env(self, log: Path) -> dict[str, str] | None:
        """A Python 3.11 venv with the dev, Sonar and audit locks, as CI installs.

        Rebuilt when one of the locks changes. None if it cannot be built.
        """
        locks = [
            self.worktree / "fork" / name
            for name in (
                "requirements-dev.lock",
                "requirements-sonar.txt",
                "requirements-audit.txt",
            )
        ]
        digest = hashlib.sha256(
            b"".join(path.read_bytes() for path in locks)
        ).hexdigest()
        venv = self.home / "venv"
        stamp = venv / ".local-ci-locks"
        if not (stamp.exists() and stamp.read_text().strip() == digest):
            shutil.rmtree(venv, ignore_errors=True)
            steps = [
                ["uv", "venv", "-q", "--python", "3.11", str(venv)],
                [
                    "uv",
                    "pip",
                    "install",
                    "-q",
                    "--python",
                    str(venv / "bin" / "python"),
                    "--require-hashes",
                    "--only-binary",
                    ":all:",
                ]
                + [arg for path in locks for arg in ("-r", str(path))],
            ]
            for step in steps:
                if self.logged(step, log) != 0:
                    return None
            stamp.write_text(digest)
        env = dict(os.environ)
        env["PATH"] = f"{venv / 'bin'}{os.pathsep}{env.get('PATH', '')}"
        env["VIRTUAL_ENV"] = str(venv)
        return env

    # ---- running ----

    def logged(
        self,
        cmd: list[str],
        log: Path,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> int:
        """Runs a command with its output appended to the log."""
        with log.open("a") as handle:
            handle.write(f"\n$ {' '.join(cmd)}\n")
            handle.flush()
            return subprocess.run(
                cmd,
                cwd=cwd or self.worktree,
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
            ).returncode

    def locked(
        self,
        lock: str,
        cmd: list[str],
        log: Path,
        cwd: Path,
        env: dict[str, str] | None = None,
    ) -> int:
        """Runs a command holding a lock directory, as the fork's agents do."""
        take(lock)
        try:
            return self.logged(cmd, log, cwd=cwd, env=env)
        finally:
            os.rmdir(lock)

    def changes(self, target: Target) -> tuple[dict[str, bool], list[str]]:
        """ci-changes.sh's areas and the changed files, against the base."""
        base = f"origin/{target.base}" if target.base else "HEAD^"
        out = subprocess.run(
            ["fork/scripts/ci-changes.sh", base],
            cwd=self.worktree,
            capture_output=True,
            text=True,
            env={**os.environ, "GITHUB_OUTPUT": "/dev/stdout"},
            check=True,
        ).stdout
        files = run(
            ["git", "diff", "--name-only", "--no-renames", base, "HEAD"],
            cwd=self.worktree,
        )
        return parse_areas(out), files.splitlines()

    def test(self, target: Target) -> bool:
        """Runs one target and posts its result. True when it passed.

        One run at a time: they share the CI worktree. A runner error posts
        "error" rather than leaving the status pending.
        """
        self.home.mkdir(parents=True, exist_ok=True)
        lock = str(self.home / "run.lock")
        take(lock)
        try:
            return self.test_locked(target)
        except (OSError, subprocess.CalledProcessError) as err:
            self.post(target.sha, "error", "Local CI: the runner failed; see its log")
            print(f"   runner error: {err}", file=sys.stderr)
            return False
        finally:
            os.rmdir(lock)

    def test_locked(self, target: Target) -> bool:
        logs = self.home / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        log = logs / f"{stamp}-{target.sha[:9]}.log"
        print(f"== {target.label} {target.sha[:9]}  log: {log}", flush=True)
        if not self.prepare(target):
            self.post(
                target.sha,
                "failure",
                f"Local CI: conflicts with {target.base}; merge it into the branch",
            )
            return False
        areas, files = self.changes(target)
        gates = gates_for(areas, target.everything)
        android = target.everything or touches_android(files)
        self.post(target.sha, "pending", description("pending", gates, android))
        ok = self.run_jobs(gates, android, log)
        state = "success" if ok else "failure"
        self.post(target.sha, state, description(state, gates, android))
        print(f"   {state}: {log}", flush=True)
        return ok

    def run_jobs(self, gates: list[str], android: bool, log: Path) -> bool:
        ok = True
        if gates:
            env = self.python_env(log)
            web = {"lint", "typecheck", "ratchet", "i18n", "build", "e2e", "vitest"}
            if env is None or (web & set(gates) and self.install_web(log) != 0):
                return False
            env["FORK_DOCKER_LOCK"] = DOCKER_LOCK
            check = str(SCRIPTS / "check.sh")
            ok = (
                self.logged(["bash", check, "--gates", ",".join(gates)], log, env=env)
                == 0
            )
            if DOCKER_GATES & set(gates):
                # Rebuilt tags leave their old images untagged; drop only those.
                self.locked(
                    DOCKER_LOCK,
                    ["docker", "image", "prune", "-f"],
                    log,
                    cwd=self.worktree,
                )
        if android:
            env = dict(os.environ)
            env.setdefault(
                "ANDROID_HOME", str(Path.home() / "Library" / "Android" / "sdk")
            )
            app = self.worktree / "fork" / "android"
            ok = (
                self.locked(ANDROID_LOCK, ["scripts/check.sh"], log, cwd=app, env=env)
                == 0
                and ok
            )
            if self.device:
                cmd = ["./gradlew", ":app:connectedDebugAndroidTest"]
                ok = self.locked(ANDROID_LOCK, cmd, log, cwd=app, env=env) == 0 and ok
        return ok

    def watch(self, interval: int, once: bool) -> None:
        """Tests every open pull request (and next) that has no result yet."""
        while True:
            self.fetch()
            for pr in self.open_prs():
                sha = str(pr.get("headRefOid"))
                try:
                    check_trusted(pr, self.owner)
                except Refused as reason:
                    print(f"skip: {reason}", flush=True)
                    continue
                if needs_run(self.statuses(sha), time.time()):
                    base = str(pr.get("baseRefName"))
                    self.test(
                        Target(f"#{pr.get('number')}", sha, base, everything=False)
                    )
            head = self.ref_target("next")
            if needs_run(self.statuses(head.sha), time.time()):
                self.test(head)
            if once:
                return
            time.sleep(interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    pr = sub.add_parser("pr", help="test one pull request")
    pr.add_argument("number", type=int)
    ref = sub.add_parser("ref", help="test a branch head with every job")
    ref.add_argument("name")
    watch = sub.add_parser(
        "watch", help="test open pull requests and next as they change"
    )
    watch.add_argument(
        "--interval", type=int, default=300, help="seconds between polls"
    )
    watch.add_argument("--once", action="store_true", help="one pass, then exit")
    for command in (pr, ref, watch):
        command.add_argument(
            "--no-post", action="store_true", help="do not post statuses"
        )
        command.add_argument(
            "--device",
            action="store_true",
            help="also run the Android instrumented tests on a connected device",
        )
    args = parser.parse_args(argv)

    runner = Runner(post=not args.no_post, device=args.device)
    try:
        if args.command == "pr":
            return 0 if runner.test(runner.pr_target(args.number)) else 1
        if args.command == "ref":
            return 0 if runner.test(runner.ref_target(args.name)) else 1
        runner.watch(args.interval, args.once)
    except Refused as reason:
        print(f"refused: {reason}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
