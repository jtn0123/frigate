"""Timezone helpers preserve offsets and invalid-zone fallbacks."""

import datetime
import unittest

from frigate.util.time import get_dst_transitions, get_timezone, get_tz_modifiers


class TestTimeZones(unittest.TestCase):
    def test_fractional_offsets_keep_signed_hour_and_minute_modifiers(self):
        for zone, expected in [
            ("Asia/Kathmandu", ("5 hour", "45 minute", 20700)),
            ("Pacific/Marquesas", ("-9 hour", "-30 minute", -34200)),
            ("UTC", ("0 hour", "0 minute", 0)),
        ]:
            with self.subTest(zone=zone):
                self.assertEqual(get_tz_modifiers(zone), expected)

    def test_dst_transition_preserves_daily_period_boundaries(self):
        start = datetime.datetime(2026, 3, 7, 12, tzinfo=datetime.UTC).timestamp()
        end = start + 2 * 86400
        self.assertEqual(
            get_dst_transitions("America/New_York", start, end),
            [(start, start + 86400, -18000), (start + 86400, end, -14400)],
        )

    def test_invalid_zone_retains_utc_fallback(self):
        for zone in ["Invalid/Timezone", "../UTC"]:
            with self.subTest(zone=zone):
                self.assertEqual(get_dst_transitions(zone, 100, 200), [(100, 200, 0)])

    def test_legacy_case_insensitive_timezone_names(self):
        self.assertEqual(get_timezone("utc").key, "UTC")
        self.assertEqual(get_timezone("america/new_york").key, "America/New_York")
