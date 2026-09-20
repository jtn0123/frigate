"""Fail if fork/audio_trial/requirements.lock does not satisfy requirements.in.

Dependabot can bump the source pins in requirements.in, but it cannot run
`uv pip compile`, so the hash-pinned lock the image installs would keep the old
version. This is the audio companion's counterpart to dev-lock-check.py: it
compares the two files directly, without installing anything.

    python3 fork/scripts/audio-lock-check.py
"""

import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_TRIAL = _HERE.parents[0] / "audio_trial"

REGENERATE = (
    "uv pip compile fork/audio_trial/requirements.in --python-version 3.11 "
    "--python-platform x86_64-unknown-linux-gnu --index-strategy unsafe-best-match "
    "--generate-hashes -o fork/audio_trial/requirements.lock"
)

# "name==version", optionally followed by a local version or an environment
# marker. Extras are part of the name for comparison purposes.
_PIN = re.compile(r"^(?P<name>[A-Za-z0-9._-]+(?:\[[^\]]+\])?)==(?P<version>[^\s;]+)")


def normalize(name: str) -> str:
    """Compare names the way PyPI does: case and separator insensitive."""
    return re.sub(r"[-_.]+", "-", name.split("[", 1)[0]).lower()


def pins(path: Path) -> dict[str, str]:
    """Map every "name==version" line in a requirements file to its version."""
    found: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip().rstrip("\\").strip()
        if not line or line.startswith("-"):
            continue
        match = _PIN.match(line)
        if match:
            found[normalize(match["name"])] = match["version"]
    return found


def drift(source: Path, lock: Path) -> list[str]:
    """Source pins the lock does not carry at the same version."""
    locked = pins(lock)
    problems = []
    for name, wanted in pins(source).items():
        have = locked.get(name)
        if have is None:
            problems.append(f"{name}=={wanted} (missing from the lock)")
        elif have.split("+", 1)[0] != wanted.split("+", 1)[0]:
            problems.append(f"{name}=={wanted} (lock has {have})")
    return problems


def main() -> int:
    source = _TRIAL / "requirements.in"
    lock = _TRIAL / "requirements.lock"
    for path in (source, lock):
        if not path.is_file():
            print(f"{path} is missing", file=sys.stderr)
            return 1
    problems = drift(source, lock)
    if not problems:
        return 0
    print(f"{lock} is out of date with {source}:", file=sys.stderr)
    for line in problems:
        print(f"  {line}", file=sys.stderr)
    print(f"Regenerate it:\n  {REGENERATE}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
