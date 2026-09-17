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

    def test_dst_transition_splits_periods_at_the_transition(self):
        start = datetime.datetime(2026, 3, 7, 12, tzinfo=datetime.UTC).timestamp()
        end = start + 2 * 86400
        spring = datetime.datetime(2026, 3, 8, 7, tzinfo=datetime.UTC).timestamp()
        self.assertEqual(
            get_dst_transitions("America/New_York", start, end),
            [(start, spring, -18000), (spring, end, -14400)],
        )

    def test_dst_transition_is_not_reported_a_day_late(self):
        # Local midnight on the day of the change used to report 2024-03-11 05:00Z
        start = datetime.datetime(2024, 3, 10, 5, tzinfo=datetime.UTC).timestamp()
        end = start + 3 * 86400
        spring = datetime.datetime(2024, 3, 10, 7, tzinfo=datetime.UTC).timestamp()
        self.assertEqual(
            get_dst_transitions("America/New_York", start, end),
            [(start, spring, -18000), (spring, end, -14400)],
        )

    def test_dst_transition_after_the_last_daily_probe_is_found(self):
        start = datetime.datetime(2024, 11, 2, 12, tzinfo=datetime.UTC).timestamp()
        end = datetime.datetime(2024, 11, 3, 10, tzinfo=datetime.UTC).timestamp()
        fall = datetime.datetime(2024, 11, 3, 6, tzinfo=datetime.UTC).timestamp()
        self.assertEqual(
            get_dst_transitions("America/New_York", start, end),
            [(start, fall, -14400), (fall, end, -18000)],
        )

    def test_invalid_zone_retains_utc_fallback(self):
        for zone in ["Invalid/Timezone", "../UTC"]:
            with self.subTest(zone=zone):
                self.assertEqual(get_dst_transitions(zone, 100, 200), [(100, 200, 0)])

    def test_legacy_case_insensitive_timezone_names(self):
        self.assertEqual(get_timezone("utc").key, "UTC")
        self.assertEqual(get_timezone("america/new_york").key, "America/New_York")
