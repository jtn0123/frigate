"""The Sonar token reminder must warn in time and fail only after the date."""

import contextlib
import importlib.util
import io
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "sonar_token_expiry", Path(__file__).with_name("sonar-token-expiry.py")
)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)

EXPIRY = date(2026, 10, 11)


class TestReadExpiry(unittest.TestCase):
    def test_reads_the_date_among_comments(self):
        text = "# not a secret\nSONAR_TOKEN_EXPIRES=2026-10-11\n"
        self.assertEqual(_MODULE.read_expiry(text), EXPIRY)

    def test_rejects_a_missing_line(self):
        with self.assertRaises(ValueError):
            _MODULE.read_expiry("# SONAR_TOKEN_EXPIRES=2026-10-11\n")

    def test_rejects_two_lines(self):
        line = "SONAR_TOKEN_EXPIRES=2026-10-11\n"
        with self.assertRaises(ValueError):
            _MODULE.read_expiry(line + line)

    def test_rejects_an_impossible_date(self):
        with self.assertRaises(ValueError):
            _MODULE.read_expiry("SONAR_TOKEN_EXPIRES=2026-02-30\n")


class TestCheck(unittest.TestCase):
    def test_quiet_more_than_fourteen_days_ahead(self):
        code, line = _MODULE.check(EXPIRY, EXPIRY - timedelta(days=15))
        self.assertEqual(code, 0)
        self.assertNotIn("::", line)

    def test_warns_from_fourteen_days_ahead(self):
        code, line = _MODULE.check(EXPIRY, EXPIRY - timedelta(days=14))
        self.assertEqual(code, 0)
        self.assertTrue(line.startswith("::warning "))
        self.assertIn("14 day(s) left", line)

    def test_still_only_warns_on_the_last_day(self):
        code, line = _MODULE.check(EXPIRY, EXPIRY)
        self.assertEqual(code, 0)
        self.assertTrue(line.startswith("::warning "))

    def test_fails_once_the_date_has_passed(self):
        code, line = _MODULE.check(EXPIRY, EXPIRY + timedelta(days=1))
        self.assertEqual(code, 1)
        self.assertTrue(line.startswith("::error "))
        self.assertIn("2026-10-11", line)


class TestMain(unittest.TestCase):
    def run_main(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sonar-token.env"
            if text is not None:
                path.write_text(text, encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = _MODULE.main(["sonar-token-expiry.py", str(path)])
        return code, out.getvalue()

    def test_a_far_date_passes_quietly(self):
        far = date.today() + timedelta(days=90)
        code, out = self.run_main(f"SONAR_TOKEN_EXPIRES={far.isoformat()}\n")
        self.assertEqual(code, 0)
        self.assertNotIn("::", out)

    def test_a_past_date_fails(self):
        past = date.today() - timedelta(days=1)
        code, out = self.run_main(f"SONAR_TOKEN_EXPIRES={past.isoformat()}\n")
        self.assertEqual(code, 1)
        self.assertIn("::error ", out)

    def test_a_missing_file_fails_with_its_name(self):
        code, out = self.run_main(None)
        self.assertEqual(code, 1)
        self.assertIn("sonar-token.env", out)

    def test_a_malformed_file_fails(self):
        code, out = self.run_main("SONAR_TOKEN_EXPIRES=soon\n")
        self.assertEqual(code, 1)
        self.assertIn("::error ", out)


if __name__ == "__main__":
    unittest.main()
