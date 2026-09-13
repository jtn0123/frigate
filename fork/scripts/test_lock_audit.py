"""A scanner is only useful if an unreviewed advisory fails the build."""

import importlib.util
import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "lock_audit", Path(__file__).with_name("lock-audit.py")
)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)

REPORT = {
    "dependencies": [
        {
            "name": "transformers",
            "version": "4.57.6",
            "vulns": [{"id": "PYSEC-2026-2289"}, {"id": "PYSEC-2026-2290"}],
        },
        {"name": "numpy", "version": "1.26.4", "vulns": []},
    ]
}


def exceptions(*ids: str) -> dict[str, object]:
    return {
        "exceptions": [
            {
                "id": identifier,
                "package": "transformers",
                "reviewed": "2026-09-13",
                "reason": "not reachable in this image",
            }
            for identifier in ids
        ]
    }


class LockAuditTests(unittest.TestCase):
    def test_findings_are_flattened_and_deduplicated(self):
        self.assertEqual(
            _MODULE.findings(REPORT),
            [
                ("transformers", "4.57.6", "PYSEC-2026-2289"),
                ("transformers", "4.57.6", "PYSEC-2026-2290"),
            ],
        )

    def test_an_advisory_without_an_exception_fails(self):
        problems = _MODULE.review(
            _MODULE.findings(REPORT), exceptions("PYSEC-2026-2289")
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("PYSEC-2026-2290", problems[0])

    def test_every_advisory_reviewed_passes(self):
        rows = _MODULE.findings(REPORT)
        allowed = exceptions("PYSEC-2026-2289", "PYSEC-2026-2290")
        self.assertEqual(_MODULE.review(rows, allowed), [])

    def test_an_exception_nothing_reports_is_stale(self):
        allowed = exceptions("PYSEC-2026-2289", "PYSEC-2026-2290", "PYSEC-2020-0001")
        problems = _MODULE.review(_MODULE.findings(REPORT), allowed)
        self.assertEqual(len(problems), 1)
        self.assertIn("no longer reported", problems[0])

    def test_the_command_passes_on_a_report_the_exceptions_cover(self):
        payload = json.loads(_MODULE.EXCEPTIONS.read_text())
        report = {
            "dependencies": [
                {
                    "name": "transformers",
                    "version": "4.57.6",
                    "vulns": [{"id": entry["id"]} for entry in payload["exceptions"]],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(json.dumps(report))
            with unittest.mock.patch.object(
                sys, "argv", ["lock-audit.py", "--json", str(path)]
            ):
                self.assertEqual(_MODULE.main(), 0)

    def test_the_command_fails_on_an_unreviewed_advisory(self):
        report = {
            "dependencies": [
                {"name": "numpy", "version": "1.26.4", "vulns": [{"id": "PYSEC-X"}]}
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(json.dumps(report))
            with unittest.mock.patch.object(
                sys, "argv", ["lock-audit.py", "--json", str(path)]
            ):
                self.assertEqual(_MODULE.main(), 1)

    def test_the_repository_exceptions_file_is_well_formed(self):
        payload = json.loads(_MODULE.EXCEPTIONS.read_text())
        self.assertTrue(payload["exceptions"])
        for entry in payload["exceptions"]:
            self.assertTrue(entry["id"] and entry["package"])
            self.assertTrue(entry["reviewed"] and entry["reason"])


if __name__ == "__main__":
    unittest.main()
