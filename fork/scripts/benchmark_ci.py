#!/usr/bin/env python3
"""Prepare isolated native CI measurements and summarize completed phases."""

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

BUILDKIT = "moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8"
BASELINE = "f0fc3760785792d22b98c847078e86b18910824d"
SEEDS = [
    "ghcr.io/jtn0123/frigate@sha256:39d0cca7a4892ff907cc0294e50f14cb5538975d3294bbc51a22dbd778f7a5dd",
    "ghcr.io/jtn0123/frigate@sha256:68e29f7eb9910f6239d342418ac4c4c832e5d89556a0d6141a33fd56bbf72b63",
]


def run(*command: str) -> str:
    """Run a command without interpreting shell metacharacters."""
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def registry(reset: bool = False) -> None:
    """Reset only this job's explicitly named local benchmark registry."""
    if reset:
        run("docker", "rm", "-f", "frigate-bench-registry")
        run("docker", "volume", "rm", "frigate-bench-registry")
    run(
        "docker",
        "run",
        "-d",
        "--name",
        "frigate-bench-registry",
        "-p",
        "127.0.0.1:5007:5000",
        "-v",
        "frigate-bench-registry:/var/lib/registry",
        "registry:2",
    )


def prepare(root: Path) -> None:
    """Freeze both source trees, cache seeds, tool versions, and machine details."""
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage("/var/lib/docker").free < 65 * 1024**3:
        raise RuntimeError("Need at least 65 GiB Docker storage before benchmarking")
    for name, ref in (("before", BASELINE), ("after", "HEAD")):
        source = root / name
        source.mkdir()
        archive = root / (name + ".tar")
        run("git", "archive", "-o", str(archive), ref)
        run("tar", "-xf", str(archive), "-C", str(source))
        archive.unlink()
        (source / "frigate/version.py").write_text(
            'VERSION = "0.18.0-build-benchmark"\n'
        )
    (root / "seed-caches.json").write_text(json.dumps(SEEDS))
    (root / "environment.json").write_text(
        json.dumps(
            {
                "platform": platform.platform(),
                "cpu": run("lscpu"),
                "memory": Path("/proc/meminfo").read_text(),
                "docker": json.loads(run("docker", "info", "--format", "{{json .}}")),
                "buildx": run("docker", "buildx", "version"),
                "buildkit": BUILDKIT,
                "baseline_commit": BASELINE,
                "candidate_commit": run("git", "rev-parse", "HEAD").strip(),
                "runner_image": os.environ.get("ImageVersion"),
                "limits": {
                    "builder_memory_gib": 5,
                    "builder_swap_gib": 0,
                    "parallelism": int(os.environ.get("MAX_PARALLELISM", "2")),
                },
            },
            indent=2,
        )
    )
    run(
        "docker",
        "context",
        "create",
        "frigate-github-bench",
        "--docker",
        "host=unix:///var/run/docker.sock",
    )
    run("docker", "pull", BUILDKIT)
    registry()


def summary(root: Path) -> None:
    """Show measured phase deltas while retaining incomplete/failed checkpoints."""
    lines = [
        "## Native AMD64 build benchmark",
        "",
        "Positive percentages mean less elapsed time. Partial milestones are not overall completion estimates.",
        "",
        "| Phase | Baseline | Candidate | Time reduction |",
        "|---|---:|---:|---:|",
    ]
    for phase in ("cold", "app-change"):
        reports = []
        for case in ("shared-zstd", "dependency-images"):
            path = root / case / f"{phase}-benchmark.timing.json"
            reports.append(json.loads(path.read_text()) if path.exists() else {})
        before, after = reports
        cells = [
            f"{r['seconds'] / 60:.2f} min ({r['status']})"
            if "seconds" in r
            else "Pending"
            for r in reports
        ]
        delta = "Pending"
        if before.get("status") == after.get("status") == "success":
            delta = f"{100 * (before['seconds'] - after['seconds']) / before['seconds']:.2f}%"
        lines.append(f"| {phase} | {cells[0]} | {cells[1]} | {delta} |")
    lines += [
        "",
        "One paired run on the same hosted VM; native CI results are separate from USB/emulation results. Full validity also requires successful build cleanup and image validation.",
    ]
    text = "\n".join(lines) + "\n"
    (root / "summary.md").write_text(text)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(text)


def validate(root: Path) -> None:
    """Fail if application contents, dependencies, or runtime configuration differ."""
    for arch in ("amd64", "rocm"):
        inventories = []
        configs = []
        for case in ("shared-zstd", "dependency-images"):
            folder = root / case
            lines = (folder / f"{arch}-smoke.log").read_text().splitlines()
            inventories.append(
                next(
                    json.loads(line)
                    for line in lines
                    if line.startswith("{") and "app_hashes" in line
                )
            )
            config = json.loads((folder / f"{arch}-config.json").read_text())
            configs.append(
                {key: config[key] for key in ("Architecture", "Os", "Config")}
            )
        if inventories[0] != inventories[1] or configs[0] != configs[1]:
            raise RuntimeError(
                f"{arch} image contents or configuration differ; inspect smoke artifacts"
            )
    refs = []
    for case in ("shared-zstd", "dependency-images"):
        refs.append(
            {
                ref
                for path in (root / case).rglob("*.log")
                for ref in re.findall(
                    r"docker\.io/[^\s@]+@sha256:[a-f0-9]{64}", path.read_text()
                )
            }
        )
    if refs[0] != refs[1]:
        raise RuntimeError("Resolved base images differ between cases")
    (root / "validation.json").write_text(
        json.dumps({"equivalence": "passed", "gpu_execution": "not tested"})
    )


def monitor(root: Path) -> None:
    """Append resource samples without placing probes inside timed build work."""
    with (root / "resources.jsonl").open("a", buffering=1) as output:
        while not (root / "stop-monitor").exists():
            sample: dict[str, Any] = {
                "time": time.time(),
                "docker_disk_free_bytes": shutil.disk_usage("/var/lib/docker").free,
                "root_disk_free_bytes": shutil.disk_usage(root).free,
                "memory": Path("/proc/meminfo").read_text(),
            }
            try:
                stats = subprocess.run(
                    ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=True,
                )
                sample["containers"] = [
                    json.loads(line) for line in stats.stdout.splitlines()
                ]
            except (subprocess.SubprocessError, ValueError) as error:
                sample["sampling_error"] = str(error)
            output.write(json.dumps(sample) + "\n")
            time.sleep(30)


def main() -> None:
    """Operate only inside the disposable GitHub-hosted benchmark job."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation", choices=("prepare", "reset", "summary", "validate", "monitor")
    )
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
    ):
        parser.error("Requires a disposable GitHub-hosted runner")
    if args.operation == "prepare":
        prepare(args.root)
    elif args.operation == "reset":
        registry(reset=True)
    elif args.operation == "monitor":
        monitor(args.root)
    elif args.operation == "validate":
        validate(args.root)
    else:
        summary(args.root)


if __name__ == "__main__":
    main()
