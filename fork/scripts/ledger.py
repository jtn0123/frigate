"""Read the fork ledger: the table in FORK.md plus one file per newer row.

Every pull request used to append its rows to the end of FORK.md, so any two
open pull requests conflicted there and had to land one rebase at a time
(I35). New rows are now files, fork/ledger/<ID>.md, each holding exactly one
row of the same five-column table. Two pull requests never touch the same
file, so they never conflict. An update to a row that is still in FORK.md's
table is made in place there.

    python3 fork/scripts/ledger.py            # the whole table, sorted by ID
    python3 fork/scripts/ledger.py --check    # validate every row file
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LEDGER = ROOT / "FORK.md"
ROW_DIR = ROOT / "fork" / "ledger"
HEADER = "| ID | Area | Files | Why | Upstream PR |"
DIVIDER = "|----|------|-------|-----|-------------|"
COLUMNS = 5

_ID = re.compile(r"^([A-Z]+)(\d+)$")
# FORK.md's older rows are not uniform (one has no closing pipe, two carry a
# note after the ID), so its table is read by the ID that opens the first
# cell. The strict checks are for the row files.
_TABLE_ROW = re.compile(r"^\| ([A-Z]+\d+)[ |]")
# A cell boundary is a pipe that is not escaped as \|
_CELL_BREAK = re.compile(r"(?<!\\)\|")


def split_row(line: str) -> list[str]:
    """Return the cells of one table row.

    Args:
        line: A markdown table row, leading and trailing pipe included

    Returns:
        The stripped cell texts

    Raises:
        ValueError: If the line is not framed by pipes
    """
    text = line.strip()
    if not (text.startswith("|") and text.endswith("|") and len(text) > 1):
        raise ValueError("a row starts and ends with |")
    return [cell.strip() for cell in _CELL_BREAK.split(text[1:-1])]


def table_ids(text: str) -> set[str]:
    """Return the IDs of the rows in FORK.md's table.

    Args:
        text: Contents of FORK.md

    Returns:
        Every first cell that looks like a ledger ID
    """
    ids = set()
    for line in text.splitlines():
        match = _TABLE_ROW.match(line)
        if match is not None:
            ids.add(match.group(1))
    return ids


def check_row_file(name: str, text: str, taken: set[str]) -> list[str]:
    """Return what is wrong with one row file, an empty list when it is fine.

    Args:
        name: File name, such as "B10.md"
        text: The file's contents
        taken: IDs that FORK.md's table already defines

    Returns:
        One message per problem
    """
    stem = name.removesuffix(".md")
    if not name.endswith(".md") or not _ID.match(stem):
        return [f"{name}: name it <ID>.md, such as B10.md"]
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        return [f"{name}: expected exactly one table row, found {len(lines)} lines"]
    try:
        cells = split_row(lines[0])
    except ValueError as err:
        return [f"{name}: {err}"]
    problems = []
    if len(cells) != COLUMNS:
        problems.append(
            f"{name}: expected {COLUMNS} cells, found {len(cells)} "
            "(write a literal pipe as \\|)"
        )
    if cells[0] != stem:
        problems.append(f"{name}: the first cell is {cells[0]!r}, not {stem!r}")
    if any(not cell for cell in cells[:4]):
        problems.append(f"{name}: only the Upstream PR cell may be empty")
    if stem in taken:
        problems.append(
            f"{name}: FORK.md's table already has a {stem} row; update it there"
        )
    return problems


def sort_key(row_id: str) -> tuple[str, int]:
    """Order IDs by category letters, then by number (B2 before B10)."""
    match = _ID.match(row_id)
    if match is None:
        return row_id, 0
    return match.group(1), int(match.group(2))


def check(ledger_text: str, row_files: dict[str, str]) -> list[str]:
    """Validate every row file against the ledger.

    Args:
        ledger_text: Contents of FORK.md
        row_files: File name to contents, for everything in fork/ledger

    Returns:
        One message per problem, in file name order
    """
    taken = table_ids(ledger_text)
    problems = []
    for name in sorted(row_files):
        problems.extend(check_row_file(name, row_files[name], taken))
    return problems


def render(ledger_text: str, row_files: dict[str, str]) -> str:
    """Return the whole ledger as one table sorted by ID.

    Args:
        ledger_text: Contents of FORK.md
        row_files: File name to contents, for everything in fork/ledger

    Returns:
        The header and every row, FORK.md's and the row files' together
    """
    rows = {}
    for line in ledger_text.splitlines():
        match = _TABLE_ROW.match(line)
        if match is not None:
            rows[match.group(1)] = line
    for name, text in row_files.items():
        rows[name.removesuffix(".md")] = text.strip()
    ordered = [rows[row_id] for row_id in sorted(rows, key=sort_key)]
    return "\n".join([HEADER, DIVIDER, *ordered]) + "\n"


def read_row_files(directory: Path = ROW_DIR) -> dict[str, str]:
    """Return file name to contents for the row files (README.md excluded)."""
    if not directory.is_dir():
        return {}
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(directory.iterdir())
        if path.is_file() and path.name != "README.md"
    }


def main(argv: list[str]) -> int:
    """Print the table, or with --check the problems in the row files."""
    ledger_text = LEDGER.read_text(encoding="utf-8")
    row_files = read_row_files()
    if argv == ["--check"]:
        problems = check(ledger_text, row_files)
        for problem in problems:
            print(problem)
        if not problems:
            print(f"fork/ledger: {len(row_files)} row file(s) are valid")
        return 1 if problems else 0
    if argv:
        print(__doc__)
        return 2
    sys.stdout.write(render(ledger_text, row_files))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
