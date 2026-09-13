"""Coverage must survive transfer from Docker and web jobs to the scanner."""

import importlib.util
import json
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


class TestCoverageFloor(unittest.TestCase):
    """A floor is only useful if it fails on a drop and tolerates noise."""

    def floor_file(self, directory: Path, **values: object) -> Path:
        payload = {"tolerance_points": 0.5, "python": None, "web": None}
        payload.update(values)
        path = directory / "fork"
        path.mkdir(parents=True, exist_ok=True)
        (path / "coverage-floor.json").write_text(json.dumps(payload))
        return directory

    def test_a_drop_beyond_the_tolerance_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.floor_file(Path(directory), python=70.0, web=30.0)
            below = _MODULE.check_floor(root, {"python": 65.0, "web": 30.2})
            self.assertEqual(len(below), 1)
            self.assertIn("python", below[0])

    def test_small_movement_within_the_tolerance_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.floor_file(Path(directory), python=70.0, web=30.0)
            self.assertEqual(_MODULE.check_floor(root, {"python": 69.6}), [])

    def test_an_unrecorded_side_reports_its_measurement_without_failing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.floor_file(Path(directory))
            self.assertEqual(_MODULE.check_floor(root, {"python": 1.0}), [])

    def test_python_and_web_rates_come_from_the_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "coverage.xml").write_text(
                '<coverage><packages><package><classes><class filename="a.py">'
                '<lines><line number="1" hits="1"/><line number="2" hits="0"/>'
                '<line number="3" hits="2"/><line number="4" hits="0"/>'
                "</lines></class></classes></package></packages></coverage>"
            )
            self.assertAlmostEqual(
                _MODULE.python_line_rate(root / "coverage.xml"), 50.0
            )
            (root / "lcov.info").write_text(
                "SF:web/src/a.ts\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nend_of_record\n"
            )
            self.assertAlmostEqual(_MODULE.web_line_rate(root / "lcov.info"), 25.0)

    def test_reports_without_measured_lines_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "coverage.xml").write_text("<coverage></coverage>")
            (root / "lcov.info").write_text("SF:web/src/a.ts\nend_of_record\n")
            with self.assertRaises(ValueError):
                _MODULE.python_line_rate(root / "coverage.xml")
            with self.assertRaises(ValueError):
                _MODULE.web_line_rate(root / "lcov.info")
