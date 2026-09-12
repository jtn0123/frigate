"""Fail if the installed dev tools do not satisfy docker/main/requirements-dev.txt.

The test image and the "Python - Lint" job install fork/requirements-dev.lock
(hash-pinned); this catches a change to requirements-dev.txt that was not
carried into the lock. Runs in the test image build (fork/Dockerfile.test).

    python3 fork/scripts/dev-lock-check.py
"""

import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from packaging.requirements import Requirement

REGENERATE = (
    "uv pip compile docker/main/requirements-dev.txt --universal "
    "--python-version 3.11 --generate-hashes --only-binary :all: "
    "-o fork/requirements-dev.lock"
)

_HERE = Path(__file__).resolve().parent
# Fixed locations rather than a command-line path: the test image copies the
# requirements file next to this script, a checkout keeps it in docker/main.
REQUIREMENTS_CANDIDATES = (
    _HERE / "requirements-dev.txt",
    _HERE.parents[1] / "docker" / "main" / "requirements-dev.txt",
)


def requirements_path() -> Path:
    for candidate in REQUIREMENTS_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "requirements-dev.txt is neither next to this script nor in docker/main"
    )


def unmet_requirements(path: Path) -> list[str]:
    unmet = []
    with open(path) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            req = Requirement(line)
            try:
                installed = version(req.name)
            except PackageNotFoundError:
                unmet.append(f"{req} (not installed)")
                continue
            if not req.specifier.contains(installed, prereleases=True):
                unmet.append(f"{req} (lock has {installed})")
    return unmet


def main() -> int:
    path = requirements_path()
    unmet = unmet_requirements(path)
    if not unmet:
        return 0
    print(f"fork/requirements-dev.lock is out of date with {path}:", file=sys.stderr)
    for line in unmet:
        print(f"  {line}", file=sys.stderr)
    print(f"Regenerate it:\n  {REGENERATE}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
