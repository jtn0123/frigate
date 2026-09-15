#!/usr/bin/env python3
"""Compare image builds on an isolated Docker context and local registry.

Run each case separately, with the same source snapshot and builder limits.
Never use this with a production Docker context or a public registry.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any


def bake_override(
    registry: str,
    case: str,
    phase: str,
    compression: str,
    seed_caches: Sequence[str] = (),
) -> dict[str, Any]:
    """Create isolated cache and image destinations for one measurement."""
    imports = [
        f"type=registry,ref={registry}/{case}:cache-{arch}"
        for arch in ("amd64", "rocm")
    ] + [f"type=registry,ref={ref}" for ref in seed_caches]
    targets: dict[str, dict[str, Any]] = {
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


def summarize_log(path: Path) -> dict[str, Any]:
    """Report unique BuildKit operations without counting progress replays twice."""
    headers: dict[str, str] = {}
    durations: dict[str, float] = {}
    cached: set[str] = set()
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


def save_json(path: Path, value: Any) -> None:
    """Atomically checkpoint measurements before any cleanup starts."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as output:
        json.dump(value, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def time_reduction(before: float, after: float) -> float | None:
    """Return percent elapsed-time reduction, or None without a valid baseline."""
    return 100 * (before - after) / before if before > 0 else None


def completed_milestones(path: Path) -> set[str]:
    """Find completed final image/cache exports, not dependency image exports."""
    headings: dict[str, str] = {}
    completed: set[str] = set()
    if not path.exists():
        return completed
    for line in path.read_text(errors="replace").splitlines():
        match = re.match(
            r"(#\d+) \[(amd64|rocm)\] exporting (to image|cache to registry)$", line
        )
        if match:
            step, target, operation = match.groups()
            headings[step] = target + (
                "-image" if operation == "to image" else "-cache"
            )
        done = re.match(r"(#\d+) DONE ", line)
        if done and done[1] in headings:
            completed.add(headings[done[1]])
    return completed


def check_disk_reserve(log_free: int, docker_free: int) -> None:
    """Protect the small log partition separately from Docker build storage."""
    if log_free < 2 * 1024**3:
        raise RuntimeError("Benchmark stopped: log partition below 2 GiB reserve")
    if docker_free < 5 * 1024**3:
        raise RuntimeError("Benchmark stopped: Docker partition below 5 GiB reserve")


def measure(command: list[str], cwd: Path, log_path: Path) -> float:
    """Persist live checkpoints and final timing independently of cleanup."""
    start = time.monotonic()
    report: dict[str, Any] = {
        "started_at": time.time(),
        "status": "running",
        "milestones": {},
        "milestone_time_reduction_percent": {},
    }
    timing = log_path.with_suffix(".timing.json")
    reference_path = os.environ.get("BENCHMARK_REFERENCE")
    reference = json.loads(Path(reference_path).read_text()) if reference_path else {}
    save_json(timing, report)
    with log_path.open("w") as log:
        process = subprocess.Popen(
            command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT
        )
        try:
            while True:
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    pass
                elapsed = time.monotonic() - start
                # The dependency orchestrator writes the final graph to a nested log.
                phase = log_path.name.split("-benchmark")[0]
                final_log = log_path.parent / phase / "application.log"
                observed = final_log if final_log.exists() else log_path
                for milestone in completed_milestones(observed):
                    if milestone not in report["milestones"]:
                        report["milestones"][milestone] = elapsed
                        before = (
                            reference.get("milestones", {}).get(milestone)
                            if reference.get("status") == "success"
                            else None
                        )
                        delta = time_reduction(before, elapsed) if before else None
                        report["milestone_time_reduction_percent"][milestone] = delta
                        print(
                            f"Milestone {milestone}: {elapsed:.1f}s; time reduction vs baseline: {delta}",
                            flush=True,
                        )
                report.update(
                    seconds=elapsed,
                    log_disk_free_bytes=shutil.disk_usage(cwd).free,
                    docker_disk_free_bytes=shutil.disk_usage(
                        os.environ.get("BENCHMARK_DOCKER_DISK", cwd)
                    ).free,
                )
                save_json(timing, report)
                print(
                    f"Benchmark {log_path.stem}: {elapsed:.1f}s elapsed; completed milestones: {sorted(report['milestones'])}",
                    flush=True,
                )
                if process.returncode is not None:
                    break
                if elapsed >= 7200:
                    raise TimeoutError("Benchmark exceeded 7200 seconds")
                check_disk_reserve(
                    report["log_disk_free_bytes"], report["docker_disk_free_bytes"]
                )
        except (RuntimeError, TimeoutError) as error:
            report["error"] = str(error)
            raise
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            report.update(
                seconds=time.monotonic() - start,
                returncode=process.returncode,
                status="success" if process.returncode == 0 else "failed",
            )
            save_json(timing, report)
    if process.returncode:
        raise RuntimeError(f"Command failed ({process.returncode}): see {log_path}")
    if reference.get("status") == "success":
        report["time_reduction_percent"] = time_reduction(
            reference["seconds"], report["seconds"]
        )
        save_json(timing, report)
        print(
            f"Completed phase time reduction: {report['time_reduction_percent']:.2f}%",
            flush=True,
        )
    return float(report["seconds"])


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
        image_options = (
            ["--driver-opt", "image=" + args.buildkit_image]
            if getattr(args, "buildkit_image", None)
            else []
        )
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
            ]
            + image_options,
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
            if args.case == "dependency-images":
                command = [
                    sys.executable,
                    str(args.source / "fork/scripts/dependency_images.py"),
                    "--source",
                    str(args.source),
                    "--context",
                    args.context,
                    "--builder",
                    builder,
                    "--repository",
                    f"{args.registry}/{args.case}",
                    "--cache",
                    f"{args.registry}/{args.case}:cache",
                    "--amd64-tags",
                    f"{args.registry}/{args.case}:{phase}-amd64",
                    "--rocm-tags",
                    f"{args.registry}/{args.case}:{phase}-rocm",
                    "--output",
                    str(args.output / phase),
                    "--refresh",
                    "benchmark",
                ]
                if args.seed_caches:
                    command += ["--seed-caches", str(args.seed_caches)]
            times[target] = measure(
                command, args.source, args.output / f"{phase}-{target}.log"
            )
        finally:
            subprocess.run(docker + ["buildx", "rm", builder], check=True)
    return times


def main() -> None:
    """Build cold and application-change cases without moving release tags."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--parallelism", type=int, choices=(1, 2, 4), default=2)
    parser.add_argument("--phase", choices=("cold", "app-change"))
    parser.add_argument("--context", default="colima-frigate-build-bench")
    parser.add_argument("--registry", default="localhost:5007")
    parser.add_argument(
        "--buildkit-image", help="Use the same pinned BuildKit image for both cases"
    )
    parser.add_argument(
        "--case",
        choices=("baseline", "shared-gzip", "shared-zstd", "dependency-images"),
        required=True,
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
        args.context not in ("colima-frigate-build-bench", "frigate-github-bench")
        or args.registry != "localhost:5007"
    ):
        parser.error("Use the dedicated benchmark context and localhost registry")
    if args.context == "frigate-github-bench" and not (
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    ):
        parser.error("GitHub benchmark context requires a GitHub-hosted runner")
    args.output.mkdir(parents=True, exist_ok=True)
    shared = args.case != "baseline"
    compression = (
        "zstd" if args.case in ("shared-zstd", "dependency-images") else "gzip"
    )
    config = args.output / "buildkit.toml"
    config.write_text(
        f"[worker.oci]\n  max-parallelism = {args.parallelism}\n"
        '[registry."localhost:5007"]\n  http = true\n  insecure = true\n'
    )
    results = {
        "parallelism": args.parallelism,
        "case": args.case,
        "phases": {},
        "source": str(args.source),
        "seed_caches": seed_caches,
    }
    if (args.output / "results.json").exists():
        results = json.loads((args.output / "results.json").read_text())
    # The same harmless source change exercises cache invalidation in both cases.
    marker = args.source / "frigate" / "build_benchmark_marker.txt"
    if marker.exists():
        parser.error("Source already contains the benchmark marker")
    try:
        for phase in [args.phase] if args.phase else ("cold", "app-change"):
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
            if args.case == "dependency-images":
                results["phases"][phase]["dependency_build"] = json.loads(
                    (args.output / phase / "results.json").read_text()
                )
                results["phases"][phase]["logs"] = {
                    path.stem: summarize_log(path)
                    for path in sorted((args.output / phase).glob("*.log"))
                }
            (args.output / "results.json").write_text(json.dumps(results, indent=2))
            print(json.dumps(results["phases"][phase]), flush=True)
    finally:
        marker.unlink(missing_ok=True)


if __name__ == "__main__":
    os.environ["HSA_OVERRIDE"] = "0"
    main()
