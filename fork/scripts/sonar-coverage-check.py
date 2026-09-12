"""Validate and normalize test coverage paths before Sonar analysis."""

import xml.etree.ElementTree as ET
from pathlib import Path

from defusedxml.ElementTree import parse


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


if __name__ == "__main__":
    python_count, web_count = prepare_reports(Path.cwd())
    print(f"Validated coverage paths: {python_count} Python, {web_count} web files")
