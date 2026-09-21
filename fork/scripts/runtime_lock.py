"""Generate or validate the architecture-specific runtime dependency locks."""

import argparse
import hashlib
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INPUTS = (
    "docker/main/requirements-wheels.txt",
    "docker/main/constraints-runtime-addons.txt",
)
PLATFORMS = {"amd64": "x86_64-manylinux_2_35", "arm64": "aarch64-manylinux_2_35"}


def input_digest(root: Path) -> str:
    """Fingerprint both reviewed resolution inputs in a stable order."""
    digest = hashlib.sha256()
    for name in INPUTS:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def content_digest(text: str) -> str:
    """Detect accidental edits or dropped entries in generated resolver output."""
    content = "\n".join(
        line for line in text.splitlines() if not line.startswith("# runtime-")
    )
    return hashlib.sha256(content.encode()).hexdigest()


def validate(root: Path, architecture: str) -> None:
    """Reject stale inputs, floating pins, missing hashes and wrong platforms."""
    path = root / f"fork/requirements-runtime-{architecture}.lock"
    text = path.read_text()
    marker = f"# runtime-input-sha256: {input_digest(root)}"
    if marker not in text.splitlines():
        raise ValueError(f"{path.name}: inputs changed; run runtime_lock.py --update")
    if f"# runtime-architecture: {architecture}" not in text.splitlines():
        raise ValueError(f"{path.name}: architecture does not match")
    content_marker = f"# runtime-content-sha256: {content_digest(text)}"
    if content_marker not in text.splitlines():
        raise ValueError(f"{path.name}: generated content changed; regenerate the lock")
    requirements = []
    for line in text.replace("\\\n", " ").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not re.fullmatch(
            r"[\w.\[\],-]+(?:==[\w.+!-]+| @ https://\S+)"
            r"(?:\s+--hash=sha256:[a-f0-9]{64})+",
            line,
        ):
            raise ValueError(f"{path.name}: unpinned or unhashed requirement")
        requirements.append(line)
    tensorflow = "tensorflow-cpu==" if architecture == "amd64" else "tensorflow=="
    if not any(line.startswith(tensorflow) for line in requirements):
        raise ValueError(f"{path.name}: missing architecture's TensorFlow package")


def update(root: Path, architecture: str) -> None:
    """Resolve CPython 3.11 Linux artifacts and record their input fingerprint."""
    output = f"fork/requirements-runtime-{architecture}.lock"
    subprocess.run(
        [
            "uv",
            "pip",
            "compile",
            INPUTS[0],
            "-c",
            INPUTS[1],
            "--python-version",
            "3.11",
            "--python-platform",
            PLATFORMS[architecture],
            "--generate-hashes",
            "--output-file",
            output,
            "--quiet",
        ],
        cwd=root,
        check=True,
    )
    path = root / output
    path.write_text(
        f"# runtime-input-sha256: {input_digest(root)}\n"
        f"# runtime-architecture: {architecture}\n"
        f"# runtime-content-sha256: {content_digest(path.read_text())}\n"
        + path.read_text()
    )
    validate(root, architecture)


def main() -> None:
    """Validate committed locks, or explicitly regenerate them with uv."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--architecture", choices=PLATFORMS)
    args = parser.parse_args()
    for architecture in [args.architecture] if args.architecture else PLATFORMS:
        if args.update:
            update(ROOT, architecture)
        else:
            validate(ROOT, architecture)
        print(f"Runtime lock {architecture}: OK")


if __name__ == "__main__":
    main()
