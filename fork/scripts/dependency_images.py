#!/usr/bin/env python3
"""Build or reuse pinned runtime dependencies before publishing Frigate images."""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import time
from pathlib import Path

# Include entire Docker directories, so new scripts, patches, and lock files
# invalidate the image without requiring a hand-maintained list of each file.
INPUT_PATHS = (
    "docker",
    ".dockerignore",
    "labelmap.txt",
    "audio-labelmap.txt",
    "fork/requirements-dev.lock",
    "fork/scripts/dependency_images.py",
)


def dependency_key(source: Path, refresh: str) -> str:
    """Hash dependency inputs, permissions, and the explicit refresh generation."""
    return input_key(source, INPUT_PATHS, refresh)


def web_key(source: Path, refresh: str) -> str:
    """Hash frontend sources and build definitions, excluding generated output."""
    return input_key(
        source,
        (
            "web",
            "docker/main/Dockerfile",
            "docker/fork-dependencies.hcl",
            ".dockerignore",
            "fork/scripts/dependency_images.py",
        ),
        refresh,
    )


def input_key(source: Path, names: tuple[str, ...], refresh: str) -> str:
    """Hash sorted source files without traversing excluded build directories."""
    digest = hashlib.sha256()
    digest.update(b"frigate-dependencies-v1-linux-amd64-hsa0\0")
    digest.update(refresh.encode() + b"\0")
    for name in names:
        path = source / name
        if not path.exists():
            raise FileNotFoundError(path)
        files = [path]
        if path.is_dir():
            files = []
            for directory, directories, filenames in os.walk(path):
                # These three directories are excluded by .dockerignore.
                if Path(directory) == source / "web":
                    directories[:] = [
                        d
                        for d in directories
                        if d not in ("node_modules", "dist", ".npm")
                    ]
                files.extend(Path(directory) / name for name in filenames)
                files.extend(
                    Path(directory) / name
                    for name in directories
                    if (Path(directory) / name).is_symlink()
                )
            files.sort()
        for file in files:
            if file.is_dir() and not file.is_symlink():
                continue
            relative = file.relative_to(source).as_posix()
            mode = stat.S_IMODE(file.lstat().st_mode)
            content = (
                os.readlink(file).encode() if file.is_symlink() else file.read_bytes()
            )
            digest.update(relative.encode() + b"\0")
            digest.update(str(mode).encode() + b"\0")
            digest.update(hashlib.sha256(content).digest())
    return digest.hexdigest()


def validate_digest(reference: str) -> str:
    """Reject mutable or malformed runtime dependency image references."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}", reference):
        raise ValueError("Dependency images must use an exact SHA256 digest")
    return reference


def image_digest(docker: list[str], reference: str) -> str | None:
    """Resolve an image, distinguishing absence from registry/network failures."""
    result = subprocess.run(
        docker
        + [
            "buildx",
            "imagetools",
            "inspect",
            "--format",
            "{{json .Manifest}}",
            reference,
        ],
        capture_output=True,
        timeout=120,
    )
    if result.returncode:
        error = result.stderr.decode(errors="replace")
        if "manifest unknown" in error.lower() or "not found" in error.lower():
            return None
        raise RuntimeError(f"Unable to inspect dependency image: {error}")
    manifest = json.loads(result.stdout)
    repository = reference.rsplit(":", 1)[0]
    return validate_digest(repository + "@" + manifest["digest"])


def main() -> None:
    """Publish dependencies when missing, then build against their exact digests."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path.cwd())
    parser.add_argument("--repository", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--amd64-tags", required=True)
    parser.add_argument("--rocm-tags", required=True)
    parser.add_argument("--context")
    parser.add_argument("--builder")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed-caches", type=Path)
    parser.add_argument(
        "--rebuild-dependencies",
        action="store_true",
        help="Refresh system packages by rebuilding dependencies without layer cache",
    )
    parser.add_argument(
        "--refresh",
        default=time.strftime("%Y-%m", time.gmtime()),
        help="Refresh generation; defaults to the UTC month for periodic rebuilding",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    docker = ["docker"] + (["--context", args.context] if args.context else [])
    bake = docker + ["buildx", "bake"]
    if args.builder:
        bake += ["--builder", args.builder]
    key = dependency_key(args.source, args.refresh)
    frontend_key = web_key(args.source, args.refresh)
    tags = {arch: f"{args.repository}:deps-{key}-{arch}" for arch in ("amd64", "rocm")}
    tags["web"] = f"{args.repository}:web-{frontend_key}"
    started = time.monotonic()
    images = {arch: image_digest(docker, tag) for arch, tag in tags.items()}
    reused = (
        all(images[arch] for arch in ("amd64", "rocm"))
        and not args.rebuild_dependencies
    )
    web_reused = bool(images["web"]) and not args.rebuild_dependencies
    seed_caches = (
        json.loads(args.seed_caches.read_text())
        if args.seed_caches
        else [
            args.cache + "-amd64",
            args.cache + "-rocm",
            "ghcr.io/blakeblackshear/frigate:cache-amd64",
            "ghcr.io/blakeblackshear/frigate:cache-rocm",
        ]
    )
    env = os.environ | {
        "CACHE": args.cache,
        "AMD64_TAGS": args.amd64_tags,
        "ROCM_TAGS": args.rocm_tags,
        "DEPENDENCY_AMD64_TAG": tags["amd64"],
        "DEPENDENCY_ROCM_TAG": tags["rocm"],
        "WEB_ASSETS_TAG": tags["web"],
        "DEPENDENCY_CACHE_FROM": ",".join(
            [args.cache + "-deps-amd64", args.cache + "-deps-rocm", args.cache + "-web"]
            + seed_caches
        ),
        "RUNTIME_CACHE_FROM": ",".join(
            [args.cache + "-app-amd64", args.cache + "-app-rocm"] + seed_caches
        ),
    }

    def build(file: str, targets: list[str], label: str) -> float:
        print(f"Building {label}; log: {args.output / (label + '.log')}", flush=True)
        start = time.monotonic()
        with (args.output / f"{label}.log").open("w") as log:
            subprocess.run(
                bake
                + (
                    ["--no-cache", "--pull"]
                    if label == "dependencies" and args.rebuild_dependencies
                    else []
                )
                + [
                    "-f",
                    file,
                    "--progress",
                    "plain",
                    "--push",
                    "--metadata-file",
                    str(args.output / f"{label}-metadata.json"),
                ]
                + targets,
                cwd=args.source,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=7200,
                check=True,
            )
        return time.monotonic() - start

    dependency_seconds = 0.0
    print(f"Dependency key: {key}; reuse: {reused}", flush=True)
    prepare = ([] if reused else ["dependencies"]) + ([] if web_reused else ["web"])
    if prepare:
        dependency_seconds = build(
            "docker/fork-dependencies.hcl", prepare, "dependencies"
        )
        images = {arch: image_digest(docker, tag) for arch, tag in tags.items()}
    if not all(images.values()):
        raise RuntimeError("Dependency publication did not produce all images")
    # The check above rules out None, but it does not narrow the dict's values.
    resolved = {arch: digest for arch, digest in images.items() if digest is not None}
    env.update(
        DEPENDENCY_AMD64_IMAGE=validate_digest(resolved["amd64"]),
        DEPENDENCY_ROCM_IMAGE=validate_digest(resolved["rocm"]),
        WEB_ASSETS_IMAGE=validate_digest(resolved["web"]),
    )
    # Save exact dependencies even if a subsequent application build fails.
    report = {
        "key": key,
        "web_key": frontend_key,
        "refresh": args.refresh,
        "images": images,
        "dependencies_reused": reused,
        "web_reused": web_reused,
        "dependency_seconds": dependency_seconds,
        "dependency_cache_bypassed": args.rebuild_dependencies,
    }
    (args.output / "dependencies.json").write_text(json.dumps(report, indent=2) + "\n")
    report["application_seconds"] = build(
        "docker/fork-runtime.hcl", ["fork"], "application"
    )
    report["total_seconds"] = time.monotonic() - started
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
