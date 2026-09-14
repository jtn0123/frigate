#!/usr/bin/env python3
"""Compare image builds on an isolated Docker context and local registry.

Run each case separately, with the same source snapshot and builder limits.
Never use this with a production Docker context or a public registry.
"""

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path


def bake_override(registry, case, phase, compression, seed_caches=()):
    """Create isolated cache and image destinations for one measurement."""
    imports = [
        f"type=registry,ref={registry}/{case}:cache-{arch}"
        for arch in ("amd64", "rocm")
    ] + [f"type=registry,ref={ref}" for ref in seed_caches]
    targets = {
        name: {"cache-from": imports}
        for name in ("wget", "deps", "rootfs", "rocm", "amd64")
    }
    targets["amd64"].update(
        dockerfile="docker/main/Dockerfile", target="frigate", platforms=["linux/amd64"]
    )
    for arch in ("amd64", "rocm"):
        cache = (
            f"type=registry,ref={registry}/{case}:cache-{arch},mode=max,"
            f"compression={compression}"
        )
        if compression == "zstd":
            cache += ",compression-level=3"
        targets[arch].update(
            tags=[f"{registry}/{case}:{phase}-{arch}"],
            **{"cache-to": [cache], "output": ["type=image,push=true"]},
        )
    return {
        "group": {"benchmark": {"targets": ["amd64", "rocm"]}},
        "target": targets,
    }


def summarize_log(path):
    """Report unique BuildKit operations without counting progress replays twice."""
    headers = {}
    durations = {}
    cached = set()
    for line in path.read_text().splitlines():
        match = re.match(r"(#\d+) (.*)", line)
        if not match:
            continue
        step, message = match.groups()
        if message.startswith("[") or message.startswith("exporting"):
            headers[step] = message
        if message == "CACHED":
            cached.add(step)
        done = re.fullmatch(r"DONE ([\d.]+)s", message)
        if done:
            durations[step] = max(durations.get(step, 0), float(done[1]))
    return {
        "cached_operations": len(cached),
        "operations": sorted(
            [
                {"step": step, "name": headers.get(step, ""), "seconds": seconds}
                for step, seconds in durations.items()
            ],
            key=lambda operation: operation["seconds"],
            reverse=True,
        ),
    }


def measure(command, cwd, log_path):
    """Record complete logs and elapsed time, failing on unsuccessful builds."""
    start = time.monotonic()
    with log_path.open("w") as log:
        result = subprocess.run(
            command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=7200
        )
    elapsed = time.monotonic() - start
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): see {log_path}")
    return elapsed


def build_targets(
    args: argparse.Namespace,
    config: Path,
    override: Path,
    phase: str,
    phases: list[str],
) -> dict[str, float]:
    """Build targets in fresh builders and remove each builder after use."""
    docker = ["docker", "--context", args.context]
    builder = f"frigate-bench-{args.case}"
    times = {}
    for target in phases:
        # New builders simulate fresh CI jobs. Only exported caches survive.
        subprocess.run(
            docker
            + [
                "buildx",
                "create",
                "--name",
                builder,
                "--driver",
                "docker-container",
                "--driver-opt",
                "network=host",
                "--driver-opt",
                "memory=5g",
                "--driver-opt",
                "memory-swap=5g",
                "--buildkitd-config",
                str(config),
            ],
            check=True,
        )
        try:
            command = docker + [
                "buildx",
                "bake",
                "--builder",
                builder,
                "-f",
                "docker/rocm/rocm.hcl",
                "-f",
                str(override),
                "--progress",
                "plain",
                "--metadata-file",
                str(args.output / f"{phase}-{target}-metadata.json"),
                target,
            ]
            times[target] = measure(
                command, args.source, args.output / f"{phase}-{target}.log"
            )
        finally:
            subprocess.run(docker + ["buildx", "rm", builder], check=True)
    return times


def main():
    """Build cold and application-change cases without moving release tags."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--context", default="colima-frigate-build-bench")
    parser.add_argument("--registry", default="localhost:5007")
    parser.add_argument(
        "--case", choices=("baseline", "shared-gzip", "shared-zstd"), required=True
    )
    parser.add_argument(
        "--seed-caches",
        type=Path,
        help="JSON list of immutable registry cache references shared by all cases",
    )
    args = parser.parse_args()
    seed_caches = json.loads(args.seed_caches.read_text()) if args.seed_caches else []
    if not isinstance(seed_caches, list) or any(
        not isinstance(ref, str)
        or not re.fullmatch(r"ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}", ref)
        for ref in seed_caches
    ):
        parser.error("Seed caches must be immutable GHCR digest references")
    if (
        args.context != "colima-frigate-build-bench"
        or args.registry != "localhost:5007"
    ):
        parser.error("Use the dedicated benchmark context and localhost registry")
    args.output.mkdir(parents=True, exist_ok=True)
    shared = args.case != "baseline"
    compression = "zstd" if args.case == "shared-zstd" else "gzip"
    config = args.output / "buildkit.toml"
    config.write_text(
        "[worker.oci]\n  max-parallelism = 2\n"
        '[registry."localhost:5007"]\n  http = true\n  insecure = true\n'
    )
    results = {
        "case": args.case,
        "phases": {},
        "source": str(args.source),
        "seed_caches": seed_caches,
    }
    # The same harmless source change exercises cache invalidation in both cases.
    marker = args.source / "frigate" / "build_benchmark_marker.txt"
    if marker.exists():
        parser.error("Source already contains the benchmark marker")
    try:
        for phase in ("cold", "app-change"):
            if phase == "app-change":
                marker.write_text("image build benchmark\n")
            override = args.output / f"{phase}.json"
            override.write_text(
                json.dumps(
                    bake_override(
                        args.registry, args.case, phase, compression, seed_caches
                    ),
                    indent=2,
                )
            )
            phases = ["benchmark"] if shared else ["amd64", "rocm"]
            times = build_targets(args, config, override, phase, phases)
            results["phases"][phase] = {
                "seconds": sum(times.values()),
                "targets": times,
                "logs": {
                    target: summarize_log(args.output / f"{phase}-{target}.log")
                    for target in phases
                },
            }
            (args.output / "results.json").write_text(json.dumps(results, indent=2))
            print(json.dumps(results["phases"][phase]), flush=True)
    finally:
        marker.unlink(missing_ok=True)


if __name__ == "__main__":
    os.environ["HSA_OVERRIDE"] = "0"
    main()
