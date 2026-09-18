"""Row files in fork/ledger must each hold one valid, unclaimed ledger row."""

import unittest
from pathlib import Path

import ledger

FORK_MD = "\n".join(
    [
        "# Fork ledger",
        "",
        ledger.HEADER,
        ledger.DIVIDER,
        "| B2 | backend | `a.py` | second | |",
        "| B10 | backend | `b.py` | tenth | |",
        "| A1 | web | `c.ts` | first | candidate |",
        "| D19 (committed as D16) | web tests | `d.ts` | noted | |",
        "",
    ]
)
ROW = "| C30 | web: share | `Share.tsx` | the dialog stays open | |\n"


class TestSplitRow(unittest.TestCase):
    def test_splits_on_unescaped_pipes_only(self):
        cells = ledger.split_row("| C1 | web | `a \\| b` | why | |")
        self.assertEqual(cells, ["C1", "web", "`a \\| b`", "why", ""])

    def test_rejects_a_line_without_the_frame(self):
        with self.assertRaises(ValueError):
            ledger.split_row("C1 | web | file | why |")


class TestTableIds(unittest.TestCase):
    def test_reads_ids_and_skips_the_header(self):
        self.assertEqual(ledger.table_ids(FORK_MD), {"A1", "B2", "B10", "D19"})


class TestCheckRowFile(unittest.TestCase):
    def test_accepts_a_valid_row(self):
        self.assertEqual(ledger.check_row_file("C30.md", ROW, {"A1"}), [])

    def test_rejects_a_name_that_is_not_an_id(self):
        problems = ledger.check_row_file("notes.md", ROW, set())
        self.assertIn("name it <ID>.md", problems[0])

    def test_rejects_two_rows(self):
        problems = ledger.check_row_file("C30.md", ROW + ROW, set())
        self.assertIn("exactly one table row", problems[0])

    def test_rejects_an_id_that_differs_from_the_name(self):
        problems = ledger.check_row_file("C31.md", ROW, set())
        self.assertTrue(any("'C30', not 'C31'" in p for p in problems))

    def test_rejects_a_stray_pipe(self):
        row = "| C30 | web | `a | b` | why | |"
        problems = ledger.check_row_file("C30.md", row, set())
        self.assertTrue(any("expected 5 cells, found 6" in p for p in problems))

    def test_rejects_an_empty_required_cell(self):
        row = "| C30 | web | `a.ts` | | |"
        problems = ledger.check_row_file("C30.md", row, set())
        self.assertTrue(any("only the Upstream PR cell" in p for p in problems))

    def test_rejects_an_id_the_table_already_defines(self):
        problems = ledger.check_row_file("C30.md", ROW, {"C30"})
        self.assertTrue(any("already has a C30 row" in p for p in problems))


class TestRender(unittest.TestCase):
    def test_merges_and_sorts_by_letter_then_number(self):
        table = ledger.render(
            FORK_MD, {"B3.md": "| B3 | backend | `d.py` | third | |\n"}
        )
        ids = [ledger.split_row(line)[0].split()[0] for line in table.splitlines()[2:]]
        self.assertEqual(ids, ["A1", "B2", "B3", "B10", "D19"])
        self.assertTrue(table.startswith(ledger.HEADER + "\n" + ledger.DIVIDER))


class TestReadRowFiles(unittest.TestCase):
    def test_a_missing_directory_is_no_rows(self):
        self.assertEqual(ledger.read_row_files(Path("/nonexistent/ledger")), {})


class TestRepository(unittest.TestCase):
    def test_the_repository_row_files_are_valid(self):
        problems = ledger.check(
            ledger.LEDGER.read_text(encoding="utf-8"), ledger.read_row_files()
        )
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
