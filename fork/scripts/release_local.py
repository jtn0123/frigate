#!/usr/bin/env python3
"""Publish main as a server release from this Mac while Actions cannot (I164).

Pushing main normally starts "Fork - Build image", which publishes the image
the server pulls (ghcr.io/jtn0123/frigate:main) and a GitHub Release whose
notes end with the build marker the app's update check looks for
(frigate/fork/updates.py). When GitHub Actions does not run for this
repository, this does the same from the Mac:

1. checks origin/main out in a worktree of its own (frigate-wt/release);
2. builds the amd64 image with dependency_images.py and pushes it as :main,
   :<version> and :<sha>-amd64 (no ROCm variant: the server does not use it);
3. publishes the release fork/<version> with release_notes.py's notes.

    make release-local                                 # build, push, release
    python3 fork/scripts/release_local.py --dry-run    # only print the plan

Versions are <upstream base>-<date>.local<n>, so they never collide with the
workflow's <date>.<run number>. A commit that already has a release keeps its
version and gets no second release, as in the workflow. The build and the
notes run this checkout's scripts on main's sources, and the build holds the
Docker lock.
Pushing needs a ghcr.io login; see fork/LOCAL-CI.md, "Publishing a release".
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from local_ci import DOCKER_LOCK, run, take
from previous_release import list_releases, newest_server_release

SCRIPTS = Path(__file__).resolve().parent
REPO = "jtn0123/frigate"
BUILDER = "frigate-release"
# The workflow's BuildKit setting: two operations at a time bounds memory.
BUILDKITD_CONFIG = "[worker.oci]\n  max-parallelism = 2\n"
SERVER_TAG_PREFIX = "fork/"


class ReleaseError(Exception):
    """A precondition failed; the message says what to do."""


@dataclass
class Plan:
    sha: str
    version: str
    released: bool
    image: str
    tags: list[str]
    previous: str | None


def released_version(releases: list[dict[str, object]], sha: str) -> str | None:
    """The version of the published server release built from sha, if any."""
    marker = f"fork-build: {sha} -->"
    for release in releases:
        tag = str(release.get("tag_name") or "")
        if (
            tag.startswith(SERVER_TAG_PREFIX)
            and not release.get("draft")
            and marker in str(release.get("body") or "")
        ):
            return tag.removeprefix(SERVER_TAG_PREFIX)
    return None


def next_version(base: str, date: str, tags: list[str]) -> str:
    """<base>-<date>.local<n>, one past the day's highest local release."""
    stem = f"{base}-{date}.local"
    pattern = re.compile(re.escape(SERVER_TAG_PREFIX + stem) + r"(\d+)")
    numbers = [int(m.group(1)) for tag in tags if (m := pattern.fullmatch(tag))]
    return f"{stem}{max(numbers, default=0) + 1}"


def image_tags(image: str, sha: str, version: str) -> list[str]:
    """The workflow's tags for a main build, minus the ROCm ones."""
    return [f"{image}:{sha[:7]}-amd64", f"{image}:{version}", f"{image}:main"]


def has_registry_login(config: Path, registry: str = "ghcr.io") -> bool:
    """Whether docker has credentials for registry (its config, not the secret)."""
    try:
        data = json.loads(config.read_text())
    except (OSError, ValueError):
        return False
    names = set(data.get("auths") or {}) | set(data.get("credHelpers") or {})
    return any(name.removeprefix("https://").rstrip("/") == registry for name in names)


def fetch_releases(repo: str) -> list[dict[str, object]]:
    """Every release of repo with its tag, draft flag and body."""
    output = run(
        [
            "gh",
            "api",
            "--paginate",
            f"repos/{repo}/releases?per_page=100",
            "--jq",
            ".[] | {tag_name, draft, body}",
        ]
    )
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def plan(repo: str, repo_root: Path, sha: str) -> Plan:
    """Work out the version and tags of a release of sha."""
    releases = fetch_releases(repo)
    image = f"ghcr.io/{repo.lower()}"
    version = released_version(releases, sha)
    released = version is not None
    if version is None:
        # upstream_base.py reads sha's history and files from git, not a checkout
        base = run(
            [
                sys.executable,
                str(SCRIPTS / "upstream_base.py"),
                "--ref",
                sha,
                "--upstream",
                "origin/dev",
                "--tag",
            ],
            cwd=repo_root,
        ).removeprefix("v")
        tags = [str(release.get("tag_name") or "") for release in releases]
        version = next_version(base, time.strftime("%Y%m%d", time.gmtime()), tags)
    previous = newest_server_release(list_releases(repo))
    return Plan(
        sha, version, released, image, image_tags(image, sha, version), previous
    )


def preflight(docker_config: Path) -> None:
    """Fail before a long build when it could not push."""
    if subprocess.run(["docker", "info"], capture_output=True).returncode:
        raise ReleaseError("Docker is not running. Start it: colima start")
    if not has_registry_login(docker_config):
        raise ReleaseError(
            "Docker is not signed in to ghcr.io, so the image cannot be pushed.\n"
            "The owner signs in once with a token that can write packages:\n"
            "  gh auth refresh -h github.com -s write:packages\n"
            "  gh auth token | docker login ghcr.io -u jtn0123 --password-stdin"
        )


def ensure_builder(home: Path) -> None:
    """A docker-container builder like the workflow's, able to build amd64."""
    if subprocess.run(
        ["docker", "buildx", "inspect", BUILDER], capture_output=True
    ).returncode:
        config = home / "buildkitd.toml"
        config.write_text(BUILDKITD_CONFIG)
        run(
            [
                "docker",
                "buildx",
                "create",
                "--name",
                BUILDER,
                "--driver",
                "docker-container",
                "--buildkitd-config",
                str(config),
            ]
        )
    platforms = run(["docker", "buildx", "inspect", "--bootstrap", BUILDER])
    if "linux/amd64" not in platforms:
        raise ReleaseError(
            "The builder cannot build amd64 (Colima loses its emulation when it "
            "restarts). Register it, then run this again:\n"
            "  docker run --privileged --rm tonistiigi/binfmt --install amd64"
        )


def checkout(repo_root: Path, worktree: Path, sha: str) -> None:
    """Puts exactly sha in the release worktree, with nothing left over."""
    if not (worktree / ".git").exists():
        worktree.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "worktree", "add", "--detach", str(worktree), sha], cwd=repo_root)
    run(["git", "checkout", "--detach", "--force", sha], cwd=worktree)
    run(["git", "clean", "-ffdxq"], cwd=worktree)
    # frigate/version.py, which the image's VERSION (and the update check) reads
    run(["make", "version"], cwd=worktree)


def build(release: Plan, source: Path, output: Path, rebuild: bool) -> None:
    """Builds and pushes the amd64 image, holding the fork's Docker lock."""
    command = [
        sys.executable,
        "-u",
        str(SCRIPTS / "dependency_images.py"),
        "--source",
        str(source),
        "--repository",
        release.image,
        "--cache",
        f"{release.image}:cache",
        "--amd64-tags",
        ",".join(release.tags),
        "--builder",
        BUILDER,
        "--output",
        str(output),
    ] + (["--rebuild-dependencies"] if rebuild else [])
    take(DOCKER_LOCK)
    try:
        subprocess.run(command, check=True)
    finally:
        os.rmdir(DOCKER_LOCK)


def publish(repo: str, release: Plan, repo_root: Path, output: Path) -> None:
    """Publishes the GitHub Release fork/<version> at sha, as the workflow does."""
    notes = run(
        [
            sys.executable,
            str(SCRIPTS / "release_notes.py"),
            "--ref",
            release.sha,
            "--upstream",
            "origin/dev",
            "--image",
            f"{release.image}:{release.version}",
        ]
        + (["--previous", release.previous] if release.previous else []),
        cwd=repo_root,
    )
    notes_file = output / "notes.md"
    notes_file.write_text(notes + "\n")
    run(
        [
            "gh",
            "release",
            "create",
            SERVER_TAG_PREFIX + release.version,
            "-R",
            repo,
            "--target",
            release.sha,
            "--title",
            release.version,
            "--notes-file",
            str(notes_file),
            "--latest",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print the plan only")
    parser.add_argument(
        "--rebuild-dependencies",
        action="store_true",
        help="refresh system packages, bypassing the dependency layer cache",
    )
    args = parser.parse_args(argv)
    repo_root = Path(run(["git", "rev-parse", "--show-toplevel"]))
    common = Path(
        run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
    )
    worktree = Path(
        os.environ.get(
            "FORK_RELEASE_WORKTREE", common.parent.parent / "frigate-wt" / "release"
        )
    )
    home = Path(
        os.environ.get("FORK_RELEASE_HOME", Path.home() / ".cache" / "frigate-release")
    )
    docker_config = (
        Path(os.environ.get("DOCKER_CONFIG", Path.home() / ".docker")) / "config.json"
    )
    try:
        run(["git", "fetch", "-q", "--tags", "origin", "main", "dev"], cwd=repo_root)
        sha = run(["git", "rev-parse", "origin/main"], cwd=repo_root)
        release = plan(REPO, repo_root, sha)
        print(f"main {sha[:9]} as {release.version}", flush=True)
        for tag in release.tags:
            print(f"  image {tag}", flush=True)
        if release.released:
            print(f"  release fork/{release.version} exists; not publishing it again")
        else:
            print(f"  release fork/{release.version} (previous: {release.previous})")
        if args.dry_run:
            return 0
        preflight(docker_config)
        home.mkdir(parents=True, exist_ok=True)
        ensure_builder(home)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        output = home / "builds" / f"{stamp}-{sha[:9]}"
        output.mkdir(parents=True)
        checkout(repo_root, worktree, sha)
        build(release, worktree, output, args.rebuild_dependencies)
        if not release.released:
            publish(REPO, release, repo_root, output)
    except ReleaseError as error:
        print(f"release-local: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"release-local: {error}; logs: {home / 'builds'}", file=sys.stderr)
        return 1
    print(f"Published {release.image}:main ({release.version})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
