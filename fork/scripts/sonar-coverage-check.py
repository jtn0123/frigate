"""Validate coverage paths before Sonar analysis, and hold coverage to a floor.

Sonar's quality gate judges new code only, so a change that deletes tests, or a
new module with none, passes every other gate. fork/coverage-floor.json records
what the suites measured when the floor was last set; this fails the job when
either side falls below it by more than the recorded tolerance (D26).
"""

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from defusedxml.ElementTree import parse

FLOOR_PATH = Path("fork/coverage-floor.json")


def resolve_source(root: Path, filename: str, prefixes: list[str]) -> str:
    """Resolve a report entry to an existing file inside the checkout."""
    for prefix in prefixes:
        candidate = (root / prefix / filename).resolve()
        if candidate.is_relative_to(root) and candidate.is_file():
            return candidate.relative_to(root).as_posix()
    raise ValueError(f"Coverage source does not resolve inside checkout: {filename}")


def prepare_reports(root: Path) -> tuple[int, int]:
    """Require nonempty Python and JavaScript coverage and normalize their paths."""
    root = root.resolve()
    xml_path = root / "coverage-py/coverage.xml"
    tree = parse(xml_path)
    sources = tree.find("sources")
    if sources is None:
        raise ValueError("Python coverage report has no sources")
    prefixes = ["", *(source.text or "" for source in sources)]
    classes = tree.findall(".//class")
    if not classes or not tree.findall(".//line"):
        raise ValueError("Python coverage report has no measured lines")
    for entry in classes:
        entry.set("filename", resolve_source(root, entry.attrib["filename"], prefixes))

    lcov_path = root / "web/coverage/lcov.info"
    lines = lcov_path.read_text().splitlines()
    count = 0
    for index, line in enumerate(lines):
        if line.startswith("SF:"):
            lines[index] = "SF:" + resolve_source(root, line[3:], ["web", ""])
            count += 1
    if not count or not any(line.startswith("DA:") for line in lines):
        raise ValueError("JavaScript coverage report has no measured lines")
    sources.clear()
    ET.SubElement(sources, "source").text = "."
    tree.write(xml_path, encoding="utf-8", xml_declaration=True)
    lcov_path.write_text("\n".join(lines) + "\n")
    return len(classes), count


def python_line_rate(xml_path: Path) -> float:
    """Measured Python line coverage as a percentage of measurable lines."""
    lines = parse(xml_path).findall(".//line")
    if not lines:
        raise ValueError("Python coverage report has no measured lines")
    covered = sum(1 for line in lines if int(line.attrib.get("hits", "0")) > 0)
    return 100 * covered / len(lines)


def web_line_rate(lcov_path: Path) -> float:
    """Measured web line coverage from the lcov DA records."""
    total = covered = 0
    for line in lcov_path.read_text().splitlines():
        if not line.startswith("DA:"):
            continue
        _, _, hits = line[3:].partition(",")
        total += 1
        covered += int(hits) > 0
    if not total:
        raise ValueError("JavaScript coverage report has no measured lines")
    return 100 * covered / total


def tolerance_for(floor: dict[str, Any], side: str) -> float:
    """Each side's allowance: one number for both, or one per side."""
    configured = floor.get("tolerance_points", 0)
    if isinstance(configured, dict):
        return float(configured.get(side, 0))
    return float(configured)


def check_floor(root: Path, measured: dict[str, float]) -> list[str]:
    """Report every side that fell below its recorded floor."""
    floor = json.loads((root / FLOOR_PATH).read_text())
    below = []
    for side, value in sorted(measured.items()):
        recorded = floor.get(side)
        if recorded is None:
            print(f"{side} coverage {value:.2f}% (no floor recorded yet)")
            continue
        tolerance = tolerance_for(floor, side)
        print(
            f"{side} coverage {value:.2f}% (floor {recorded}%, tolerance {tolerance})"
        )
        if value < float(recorded) - tolerance:
            below.append(
                f"{side} coverage fell to {value:.2f}%, below the {recorded}% floor"
            )
    return below


def main(root: Path | None = None) -> int:
    """Normalize both reports, then hold each side to its floor."""
    root = Path.cwd() if root is None else root
    python_count, web_count = prepare_reports(root)
    print(f"Validated coverage paths: {python_count} Python, {web_count} web files")
    below = check_floor(
        root,
        {
            "python": python_line_rate(root / "coverage-py/coverage.xml"),
            "web": web_line_rate(root / "web/coverage/lcov.info"),
        },
    )
    if not below:
        return 0
    for line in below:
        print(f"::error::{line}")
    print(
        "Add tests, or lower the floor in fork/coverage-floor.json in the same "
        "commit that explains why",
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
