"""Tests that the Intel generation scan matches what the old regex did."""

import unittest

from frigate.util.hwaccel import intel_generation_digits

# each sample with what the replaced r"(\d+)th Gen" search captured
SAMPLES = (
    ("13th Gen Intel(R) Core(TM) i5-13500", "13"),
    ("12th Gen Intel(R) Core(TM) i7-12700K", "12"),
    ("model name\t: 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz", "11"),
    ("Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz", None),
    ("Intel(R) Core(TM) Ultra 7 155H", None),
    ("x1234th Gen", "1234"),
    ("i5-13th Gen", "13"),
    ("8th Gen 9th Gen", "8"),
    ("13th gen lowercase", None),
    ("13th  Gen double space", None),
    ("th Gen", None),
    ("", None),
    ("0th Gen", "0"),
    ("00013th Gen", "00013"),
    ("13 th Gen", None),
    ("13thGen", None),
    ("13th Gen\n14th Gen", "13"),
    ("th Gen 7th Gen", "7"),
    ("١٣th Gen", "١٣"),
)


class TestIntelGenerationDigits(unittest.TestCase):
    def test_matches_the_legacy_pattern(self) -> None:
        for sample, expected in SAMPLES:
            with self.subTest(sample=sample):
                self.assertEqual(intel_generation_digits(sample), expected)

    def test_long_digit_run_without_suffix_does_not_match(self) -> None:
        # the legacy pattern rescans the run from every digit, which is
        # quadratic; the scan only looks for the suffix
        self.assertIsNone(intel_generation_digits("1" * 100_000 + "th gen"))

    def test_long_digit_run_with_suffix_captures_the_whole_run(self) -> None:
        digits = "7" * 10_000

        self.assertEqual(intel_generation_digits(f"cpu {digits}th Gen"), digits)


if __name__ == "__main__":
    unittest.main()
