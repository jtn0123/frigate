"""Coverage must survive transfer from Docker and web jobs to the scanner."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

from defusedxml.common import EntitiesForbidden

_SPEC = importlib.util.spec_from_file_location(
    "sonar_coverage", Path(__file__).with_name("sonar-coverage-check.py")
)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


class TestSonarCoverage(unittest.TestCase):
    def test_normalizes_both_reports_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("frigate/api.py", "web/src/player.ts"):
                path = root / name
                path.parent.mkdir(parents=True)
                path.touch()
            (root / "coverage-py").mkdir()
            (root / "web/coverage").mkdir()
            xml = root / "coverage-py/coverage.xml"
            xml.write_text(
                "<coverage><sources><source>frigate</source></sources>"
                '<packages><package><classes><class filename="api.py">'
                '<lines><line number="1" hits="1"/></lines></class>'
                "</classes></package></packages></coverage>"
            )
            lcov = root / "web/coverage/lcov.info"
            lcov.write_text("SF:src/player.ts\nDA:1,1\nend_of_record\n")
            self.assertEqual(_MODULE.prepare_reports(root), (1, 1))
            self.assertIn('filename="frigate/api.py"', xml.read_text())
            self.assertIn("SF:web/src/player.ts", lcov.read_text())
            self.assertEqual(_MODULE.prepare_reports(root), (1, 1))

    def test_missing_or_external_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ("missing.py", __file__):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    _MODULE.resolve_source(root, name, ["", "frigate"])

    def test_missing_report_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                _MODULE.prepare_reports(Path(directory))

    def test_xml_entities_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "coverage-py").mkdir()
            (root / "coverage-py/coverage.xml").write_text(
                '<!DOCTYPE coverage [<!ENTITY injected "unexpected">]>'
                "<coverage>&injected;</coverage>"
            )
            with self.assertRaises(EntitiesForbidden):
                _MODULE.prepare_reports(root)

    def test_empty_xml_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "coverage-py").mkdir()
            (root / "coverage-py/coverage.xml").write_text(
                "<coverage><sources><source>.</source></sources></coverage>"
            )
            with self.assertRaisesRegex(ValueError, "no measured lines"):
                _MODULE.prepare_reports(root)
