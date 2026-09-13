"""Scan the fork's own dependency locks for known advisories.

Everything that reaches the published image is scanned by Dependabot and
CodeQL; the fork's side images (the audio companion and the backend test image)
install from their own locks, which nothing looked at until E7.

Advisories that do not apply to how the fork runs a package are listed with a
reason in fork/audit-exceptions.json. An exception that no longer matches a
reported advisory fails too, so the list cannot outlive its subject.

    python3 fork/scripts/lock-audit.py           # every lock
    python3 fork/scripts/lock-audit.py --json X  # pip-audit JSON, for tests
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
EXCEPTIONS = _ROOT / "audit-exceptions.json"

# The audio companion installs torch from PyTorch's CPU index; pip-audit needs
# the same index to resolve it, and reports it as skipped either way.
TARGETS: dict[str, list[str]] = {
    "fork/audio_trial/requirements.lock": [
        "--extra-index-url",
        "https://download.pytorch.org/whl/cpu",
    ],
    "fork/requirements-dev.lock": [],
    "fork/requirements-sonar.txt": [],
}


def audit(requirements: str, extra: list[str]) -> dict[str, Any]:
    """Run pip-audit over one requirements file and return its JSON report."""
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip_audit",
            "-r",
            requirements,
            "--no-deps",
            "--format",
            "json",
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if not result.stdout:
        raise RuntimeError(
            f"pip-audit produced no report for {requirements}:\n{result.stderr}"
        )
    report: dict[str, Any] = json.loads(result.stdout)
    return report


def findings(report: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Flatten a report into (package, version, advisory id) rows."""
    rows = []
    for dependency in report.get("dependencies", []):
        for vulnerability in dependency.get("vulns", []):
            rows.append(
                (dependency["name"], dependency.get("version", ""), vulnerability["id"])
            )
    return sorted(set(rows))


def review(rows: list[tuple[str, str, str]], exceptions: dict[str, Any]) -> list[str]:
    """Report advisories with no exception, and exceptions nothing reported."""
    allowed = {
        (entry["package"], entry["id"]): entry for entry in exceptions["exceptions"]
    }
    problems = []
    seen = set()
    for package, version, identifier in rows:
        entry = allowed.get((package, identifier))
        if entry is None:
            problems.append(
                f"{package} {version}: {identifier} has no reviewed exception"
            )
            continue
        seen.add((package, identifier))
        print(f"  allowed {package} {identifier}: {entry['reason']}")
    for key in sorted(allowed.keys() - seen):
        problems.append(
            f"{key[0]}: exception for {key[1]} is no longer reported; remove it "
            "from fork/audit-exceptions.json"
        )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json", type=Path, help="read a saved pip-audit report instead"
    )
    args = parser.parse_args()
    exceptions = json.loads(EXCEPTIONS.read_text())
    problems = []
    if args.json:
        reports = {str(args.json): json.loads(args.json.read_text())}
    else:
        reports = {name: audit(name, extra) for name, extra in TARGETS.items()}
    rows: list[tuple[str, str, str]] = []
    for name, report in reports.items():
        found = findings(report)
        print(f"{name}: {len(found)} advisories")
        rows += found
    # Reviewed once over every lock, so an exception that applies to one file is
    # not reported as stale by the others.
    problems += review(sorted(set(rows)), exceptions)
    if problems:
        for line in problems:
            print(f"::error::{line}")
        return 1
    print("No unreviewed advisories in the fork's locks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
