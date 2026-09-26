"""Tests that the Intel generation pattern matches what the old pattern did."""

import re
import unittest

from frigate.util.hwaccel import INTEL_GEN_PATTERN

# the pattern before the lookbehind was added, kept as the reference
LEGACY_INTEL_GEN_PATTERN = re.compile(r"(\d+)th Gen")

SAMPLES = (
    "13th Gen Intel(R) Core(TM) i5-13500",
    "12th Gen Intel(R) Core(TM) i7-12700K",
    "model name\t: 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz",
    "Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz",
    "Intel(R) Core(TM) Ultra 7 155H",
    "x1234th Gen",
    "i5-13th Gen",
    "8th Gen 9th Gen",
    "13th gen lowercase",
    "13th  Gen double space",
    "th Gen",
    "",
    "0th Gen",
    "00013th Gen",
    "13 th Gen",
    "13thGen",
    "13th Gen\n14th Gen",
)


class TestIntelGenPattern(unittest.TestCase):
    def test_matches_the_legacy_pattern(self) -> None:
        for sample in SAMPLES:
            with self.subTest(sample=sample):
                expected = LEGACY_INTEL_GEN_PATTERN.search(sample)
                actual = INTEL_GEN_PATTERN.search(sample)

                if expected is None:
                    self.assertIsNone(actual)
                    continue

                self.assertIsNotNone(actual)
                assert actual is not None
                self.assertEqual(actual.group(1), expected.group(1))
                self.assertEqual(actual.span(), expected.span())

    def test_long_digit_run_without_suffix_does_not_match(self) -> None:
        # the legacy pattern rescans the run from every digit, which is
        # quadratic; the anchored one fails once per run
        self.assertIsNone(INTEL_GEN_PATTERN.search("1" * 100_000 + "th gen"))

    def test_long_digit_run_with_suffix_captures_the_whole_run(self) -> None:
        digits = "7" * 10_000
        match = INTEL_GEN_PATTERN.search(f"cpu {digits}th Gen")

        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match.group(1), digits)


if __name__ == "__main__":
    unittest.main()
