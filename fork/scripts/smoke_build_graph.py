#!/usr/bin/env python3
"""Exercise the real application graph using tiny, published fixture images."""

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

from dependency_images import image_digest

BUILDKIT = "moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8"


def main():
    """Catch image-context resolution failures before expensive benchmarks."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument(
        "--context",
        choices=("frigate-github-bench", "colima-frigate-build-bench"),
        required=True,
    )
    args = parser.parse_args()
    if (
        args.context == "frigate-github-bench"
        and os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
    ):
        parser.error("Requires a disposable GitHub-hosted runner")
    source = Path(__file__).resolve().parents[2]
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for folder in ("docker", "frigate", "migrations"):
        (root / folder).mkdir(exist_ok=True)
    for name in (
        "fork-rootfs.Dockerfile",
        "fork-runtime.Dockerfile",
        "fork-runtime.hcl",
    ):
        shutil.copyfile(source / "docker" / name, root / "docker" / name)
    (root / "frigate/marker").write_text("application")
    (root / "migrations/marker").write_text("migration")
    (root / "runtime-marker").write_text("runtime")
    (root / "index.html").write_text("frontend")
    (root / "Fixture.Dockerfile").write_text(
        "FROM scratch AS runtime\nCOPY runtime-marker /base-marker\nFROM scratch AS web\nCOPY index.html /work/dist/index.html\n"
    )
    config = root / "buildkit.toml"
    config.write_text('[registry."localhost:5007"]\n  http = true\n  insecure = true\n')
    docker = ["docker", "--context", args.context]
    builder = "frigate-bench-graph-smoke"

    def run(command, **kwargs):
        subprocess.run(command, check=True, timeout=300, **kwargs)

    run(
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
            "image=" + BUILDKIT,
            "--driver-opt",
            "memory=5g",
            "--driver-opt",
            "memory-swap=5g",
            "--buildkitd-config",
            str(config),
        ]
    )
    try:
        refs = {}
        for target in ("runtime", "web"):
            tag = "localhost:5007/graph-smoke:" + target
            run(
                docker
                + [
                    "buildx",
                    "build",
                    "--builder",
                    builder,
                    "--platform",
                    "linux/amd64",
                    "-f",
                    str(root / "Fixture.Dockerfile"),
                    "--target",
                    target,
                    "-t",
                    tag,
                    "--push",
                    str(root),
                ]
            )
            refs[target] = image_digest(docker, tag)
            if not refs[target]:
                raise RuntimeError("Fixture image was not published")
        env = os.environ | {
            "DEPENDENCY_AMD64_IMAGE": refs["runtime"],
            "DEPENDENCY_ROCM_IMAGE": refs["runtime"],
            "WEB_ASSETS_IMAGE": refs["web"],
            "RUNTIME_CACHE_FROM": "localhost:5007/graph-smoke:unused",
            "CACHE": "localhost:5007/graph-smoke:cache",
            "AMD64_TAGS": "localhost:5007/graph-smoke:amd64",
            "ROCM_TAGS": "localhost:5007/graph-smoke:rocm",
        }
        overrides = {
            "target": {
                name: {
                    "cache-to": [],
                    "output": ["type=local,dest=" + str(root / name)],
                }
                for name in ("amd64", "rocm")
            }
        }
        (root / "outputs.json").write_text(json.dumps(overrides))
        run(
            docker
            + [
                "buildx",
                "bake",
                "--builder",
                builder,
                "-f",
                "docker/fork-runtime.hcl",
                "-f",
                "outputs.json",
                "--progress",
                "plain",
                "fork",
            ],
            cwd=root,
            env=env,
        )
        for name in ("amd64", "rocm"):
            for path, expected in {
                "base-marker": "runtime",
                "opt/frigate/frigate/marker": "application",
                "opt/frigate/migrations/marker": "migration",
                "opt/frigate/web/index.html": "frontend",
            }.items():
                if (root / name / path).read_text() != expected:
                    raise RuntimeError(f"{name}: missing expected {path}")
        (root / "passed.json").write_text(
            json.dumps({"image_contexts": "passed", "application_contents": "passed"})
        )
        print("Real application build graph smoke test passed", flush=True)
    finally:
        run(docker + ["buildx", "rm", builder])


if __name__ == "__main__":
    main()
