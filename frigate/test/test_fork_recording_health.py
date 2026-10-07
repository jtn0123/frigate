"""Recording health regression tests for fragmented and unavailable history."""

import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate.fork.recording_health import (
    BUCKET_SECONDS,
    MAX_BUCKETS,
    MAX_ROWS,
    MAX_WORK_PER_TICK,
    Bucket,
    Policy,
    RecordingHealth,
    coverage_bucket,
)

BASE = 1_800_000_000.0  # An exact five-minute boundary.


def config(*, enabled=True, recording=True, days=28):
    """Build only the non-secret policy fields consumed by the collector."""
    return SimpleNamespace(
        cameras={
            "front": SimpleNamespace(
                enabled=enabled,
                record=SimpleNamespace(
                    enabled=recording,
                    continuous=SimpleNamespace(days=days),
                ),
            )
        },
        database=SimpleNamespace(path="unused.db"),
    )


class TestCoverage(unittest.TestCase):
    def test_overlaps_duplicates_and_crossing_edges_are_unioned(self):
        bucket = coverage_bucket([(-10, 50), (0, 50), (40, 200), (200, 310)], 0)
        self.assertEqual(bucket, Bucket("analyzed"))

    def test_fragmented_fresh_recordings_retain_half_the_footage(self):
        bucket = coverage_bucket([(i, i + 0.5) for i in range(300)], 0)
        self.assertEqual(bucket.missing, 150)
        self.assertEqual(bucket.longest_inner, 0.5)
        self.assertEqual(bucket.inner_count, 0)
        result = RecordingHealth._summary(Policy("analyzed"), [(0, bucket)], 3600, 1)
        self.assertEqual(result["status"], "gaps")
        self.assertEqual(result["coverage_percent"], 50)
        self.assertEqual(result["gap_count"], 0)
        self.assertEqual(result["longest_gap_seconds"], 0.5)

    def test_empty_successful_scan_is_a_real_full_gap(self):
        bucket = coverage_bucket([], 0)
        result = RecordingHealth._summary(None, [(0, bucket)], 3600, 1)
        self.assertEqual(result["coverage_percent"], 0)
        self.assertEqual(result["missing_seconds"], 300)
        self.assertEqual(result["gap_count"], 1)

    def test_normal_small_boundary_gaps_do_not_warn(self):
        bucket = coverage_bucket([(0.001, 299.999)], 0)
        result = RecordingHealth._summary(None, [(0, bucket)], 3600, 1)
        self.assertEqual(result["status"], "ok")
        self.assertGreater(result["missing_seconds"], 0)

    def test_significant_gap_warns_even_with_high_overall_coverage(self):
        rows = [(slot, Bucket("analyzed")) for slot in range(12)]
        rows[0] = (0, coverage_bucket([(10, 300)], 0))
        result = RecordingHealth._summary(None, rows, 3600, 12)
        self.assertGreater(result["coverage_percent"], 99)
        self.assertEqual(result["status"], "gaps")

    def test_split_gap_crosses_significance_threshold_only_when_joined(self):
        rows = [
            (0, coverage_bucket([(0, 294)], 0)),
            (1, coverage_bucket([(304, 600)], 300)),
        ]
        result = RecordingHealth._summary(None, rows, 3600, 2)
        self.assertEqual(result["gap_count"], 1)
        self.assertEqual(result["longest_gap_seconds"], 10)
        self.assertEqual(result["missing_seconds"], 10)

    def test_gap_merges_through_a_fully_uncovered_middle_bucket(self):
        rows = [
            (0, coverage_bucket([(0, 290)], 0)),
            (1, coverage_bucket([], 300)),
            (2, coverage_bucket([(610, 900)], 600)),
        ]
        result = RecordingHealth._summary(None, rows, 3600, 3)
        self.assertEqual(result["gap_count"], 1)
        self.assertEqual(result["longest_gap_seconds"], 320)

    def test_unknown_and_unobserved_buckets_do_not_connect_gaps(self):
        for middle in ([], [(1, Bucket("unknown"))], [(1, Bucket("disabled"))]):
            with self.subTest(middle=middle):
                rows = [
                    (0, coverage_bucket([(0, 290)], 0)),
                    *middle,
                    (2, coverage_bucket([(610, 900)], 600)),
                ]
                result = RecordingHealth._summary(None, rows, 3600, 3)
                self.assertEqual(result["analyzed_seconds"], 600)
                self.assertEqual(result["gap_count"], 2)
                self.assertEqual(result["longest_gap_seconds"], 10)

    def test_large_and_small_gaps_are_counted_without_double_counting(self):
        bucket = coverage_bucket([(12, 30), (35, 50), (65, 288)], 0)
        result = RecordingHealth._summary(None, [(0, bucket)], 3600, 1)
        self.assertEqual(result["missing_seconds"], 44)
        self.assertEqual(result["gap_count"], 3)
        self.assertEqual(result["longest_gap_seconds"], 15)

    def test_bad_or_truncated_rows_cannot_report_partial_coverage(self):
        for rows in (
            [(0, float("nan"))],
            [(20, 10)],
            [(0, 601)],
            [(0, 300)] * (MAX_ROWS + 1),
        ):
            with self.subTest(rows_count=len(rows)):
                with self.assertRaises(ValueError):
                    coverage_bucket(rows, 0)

    def test_persisted_buckets_validate_gap_totals_and_round_trip(self):
        for intervals in ([], [(0.01, 299.99)], [(10, 90), (105, 200), (205, 290)]):
            with self.subTest(intervals=intervals):
                bucket = coverage_bucket(intervals, 0)
                self.assertEqual(Bucket.decode(bucket.encode()), bucket)
        for invalid in (
            [0, 0, 0, 0, 0, 1],
            [0, 300, 0, 0, 0, 0],
            [0, 30, 10, 10, 20, 1],
            [0, 30, 10, 10, 10, 2],
            [0, 30, 10, 10, 10, 0],
        ):
            with self.subTest(invalid=invalid):
                self.assertIsNone(Bucket.decode(invalid))


class TestCollector(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "health.json"
        self.now = BASE
        self.reader = Mock(side_effect=lambda camera, start, end: [(start, end)])
        self.store = self.make_store()

    def make_store(self, policy=None):
        return RecordingHealth(
            policy or config(),
            threading.Event(),
            self.path,
            row_reader=self.reader,
            clock=lambda: self.now,
        )

    def advance(self, end):
        while self.now < end:
            self.now = min(self.now + 15, end)
            self.store.collect()

    def summary(self):
        return self.store.read("1h")["front"]

    def test_startup_has_no_backfill_and_waits_for_ingestion(self):
        self.assertIsNone(self.summary()["coverage_percent"])
        self.advance(BASE + 419)
        self.reader.assert_not_called()
        self.assertEqual(self.summary()["analyzed_seconds"], 0)
        self.advance(BASE + 420)
        self.reader.assert_called_once_with("front", BASE, BASE + 300)
        result = self.summary()
        self.assertEqual(result["coverage_percent"], 100)
        self.assertEqual(result["analyzed_seconds"], 300)
        self.assertEqual(result["requested_seconds"], 3600)
        self.assertEqual(result["mature_before"], BASE + 300)
        self.assertEqual(result["latest_analyzed_end"], BASE + 300)

    def test_mid_bucket_start_is_unknown_even_if_database_has_footage(self):
        self.now += 15
        self.store = self.make_store()
        self.advance(BASE + 420)
        self.reader.assert_not_called()
        self.assertEqual(self.summary()["status"], "unknown")

    def test_observer_pause_does_not_fabricate_an_outage(self):
        self.advance(BASE + 150)
        self.now = BASE + 240
        self.store.collect()
        self.advance(BASE + 420)
        self.reader.assert_not_called()
        self.assertEqual(self.summary()["missing_seconds"], 0)
        self.assertIsNone(self.summary()["coverage_percent"])

    def test_runtime_policy_transition_makes_the_bucket_unknown(self):
        self.advance(BASE + 150)
        self.store.update_config(config(recording=False))
        self.advance(BASE + 420)
        self.reader.assert_not_called()
        self.assertEqual(self.summary()["analyzed_seconds"], 0)
        self.assertEqual(self.summary()["missing_seconds"], 0)

    def test_disabled_event_only_and_short_retention_do_not_query(self):
        for policy, status in (
            (config(enabled=False), "disabled"),
            (config(recording=False), "disabled"),
            (config(days=0), "not_continuous"),
            (config(days=300 / 86400), "unknown"),
        ):
            with self.subTest(status=status):
                self.now = BASE
                self.store = self.make_store(policy)
                self.advance(BASE + 420)
                self.assertEqual(self.summary()["status"], status)
                self.assertIsNone(self.summary()["coverage_percent"])
        self.reader.assert_not_called()

    def test_database_failure_is_unknown_and_does_not_kill_collection(self):
        self.reader.side_effect = sqlite3.OperationalError("locked")
        with self.assertLogs("frigate.fork.recording_health", "WARNING"):
            self.advance(BASE + 420)
        self.assertEqual(self.summary()["status"], "unknown")
        self.reader.side_effect = lambda camera, start, end: [(start, end)]
        self.advance(BASE + 720)
        self.assertEqual(self.summary()["analyzed_seconds"], 600)
        self.assertEqual(self.summary()["coverage_percent"], 100)

    def test_late_registration_repairs_a_recent_deficit(self):
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 420)
        self.assertEqual(self.summary()["status"], "gaps")
        self.assertEqual(self.summary()["missing_seconds"], 20)
        self.reader.side_effect = lambda camera, start, end: [(start, end)]
        self.advance(BASE + 480)
        self.assertEqual(self.summary()["coverage_percent"], 100)
        self.assertEqual(self.summary()["gap_count"], 0)
        self.assertEqual(self.summary()["status"], "ok")
        self.assertEqual(self.store._rechecks, {})

    def test_recheck_failure_or_deleted_rows_do_not_reduce_observed_coverage(self):
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 420)
        original = self.summary()
        self.reader.side_effect = sqlite3.OperationalError("locked")
        with self.assertLogs("frigate.fork.recording_health", "WARNING"):
            self.advance(BASE + 480)
        self.assertEqual(self.summary(), original)
        self.reader.side_effect = lambda camera, start, end: []
        self.advance(BASE + 540)
        self.assertEqual(self.summary(), original)

    def test_policy_reduction_invalidates_pending_retention_guarantee(self):
        self.advance(BASE + 330)
        self.store.update_config(config(days=360 / 86400))
        self.advance(BASE + 420)
        self.reader.assert_not_called()
        self.assertEqual(self.summary()["status"], "unknown")

    def test_policy_change_during_database_query_cannot_report_health(self):
        def change_policy(camera, start, end):
            self.store.update_config(config(recording=False))
            return [(start, end)]

        self.reader.side_effect = change_policy
        self.advance(BASE + 420)
        self.assertIsNone(self.summary()["coverage_percent"])
        self.assertEqual(self.summary()["missing_seconds"], 0)
        self.assertEqual(self.store._rechecks, {})

    def test_expiring_retention_during_query_leaves_unknown_history(self):
        self.store = self.make_store(config(days=421 / 86400))

        def delayed_rows(camera, start, end):
            self.now += 2
            return []

        self.reader.side_effect = delayed_rows
        self.advance(BASE + 420)
        self.assertEqual(self.summary()["status"], "unknown")
        self.assertEqual(self.summary()["missing_seconds"], 0)

    def test_policy_reduction_cancels_recheck_without_erasing_observation(self):
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 420)
        self.store.update_config(config(days=360 / 86400))
        self.advance(BASE + 480)
        self.reader.assert_called_once()
        self.assertEqual(self.summary()["missing_seconds"], 20)
        self.assertEqual(self.store._rechecks, {})

    def test_rechecks_stop_before_original_retention_expires(self):
        self.store = self.make_store(config(days=470 / 86400))
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 480)
        self.reader.assert_called_once()
        self.assertEqual(self.store._rechecks, {})

    def test_rechecks_are_limited_to_three_recent_buckets(self):
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 1320)
        self.assertEqual(len(self.store._rechecks), 3)
        self.assertNotIn(("front", int(BASE // 300)), self.store._rechecks)

    def test_first_assessments_and_rechecks_share_the_work_limit(self):
        policies = config()
        camera = policies.cameras["front"]
        policies.cameras = {str(index): camera for index in range(MAX_WORK_PER_TICK)}
        self.store = self.make_store(policies)
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 705)
        count = self.reader.call_count
        self.advance(BASE + 720)
        self.assertEqual(self.reader.call_count - count, MAX_WORK_PER_TICK)

    def test_row_limit_failure_is_unknown_not_a_recording_gap(self):
        self.reader.side_effect = lambda camera, start, end: (
            [(start, end)] * (MAX_ROWS + 1)
        )
        with self.assertLogs("frigate.fork.recording_health", "WARNING"):
            self.advance(BASE + 420)
        self.assertEqual(self.summary()["status"], "unknown")
        self.assertEqual(self.summary()["missing_seconds"], 0)

    def test_completed_observations_survive_retention_deletion(self):
        self.advance(BASE + 420)
        self.reader.side_effect = lambda camera, start, end: []
        self.advance(BASE + 450)
        self.reader.assert_called_once()
        self.assertEqual(self.summary()["coverage_percent"], 100)

    def test_persistence_survives_restart_without_filling_downtime(self):
        self.advance(BASE + 420)
        self.store.flush()
        self.now = BASE + 1200
        self.store = self.make_store()
        self.assertEqual(self.summary()["analyzed_seconds"], 300)
        self.advance(BASE + 1620)
        self.assertEqual(self.summary()["analyzed_seconds"], 600)
        self.assertEqual(self.reader.call_count, 2)

    def test_restart_does_not_reconstruct_recent_recheck_guarantees(self):
        self.reader.side_effect = lambda camera, start, end: [(start, end - 20)]
        self.advance(BASE + 420)
        self.store.flush()
        self.store = self.make_store()
        self.advance(BASE + 480)
        self.reader.assert_called_once()
        self.assertEqual(self.summary()["missing_seconds"], 20)

    def test_corrupt_snapshot_is_ignored(self):
        self.path.write_text("not json")
        with self.assertLogs("frigate.fork.recording_health", "WARNING"):
            self.store = self.make_store()
        self.assertEqual(self.summary()["status"], "unknown")

    def test_future_and_invalid_persisted_buckets_are_ignored(self):
        slot = int(BASE // BUCKET_SECONDS)
        self.path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "cameras": {
                        "front": {
                            str(slot + 1): Bucket("analyzed").encode(),
                            str(slot - 1): [0, -1, 0, 0, 0, 0],
                            str(slot - 2): [0, 10, 9, 9, 0, 0],
                            str(slot - 3): [False, 0, 0, 0, 0, 0],
                        }
                    },
                }
            )
        )
        self.store = self.make_store()
        self.assertEqual(self.summary()["analyzed_seconds"], 0)

    def test_failed_atomic_save_keeps_previous_snapshot_and_retries(self):
        self.advance(BASE + 420)
        self.store.flush()
        original = self.path.read_bytes()
        with (
            patch("frigate.fork.recording_health.os.fsync", side_effect=OSError),
            self.assertLogs("frigate.fork.recording_health", "WARNING"),
        ):
            self.advance(BASE + 720)
            self.store.flush()
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])
        self.store.flush()
        self.assertNotEqual(self.path.read_bytes(), original)

    def test_history_is_bounded_to_seven_days(self):
        self.advance(BASE + 420)
        slot = int(BASE // BUCKET_SECONDS)
        self.store._buckets["front"] = {
            slot - i: Bucket("analyzed") for i in range(MAX_BUCKETS + 20)
        }
        self.store.collect()
        self.assertLessEqual(len(self.store._buckets["front"]), MAX_BUCKETS)

    def test_backward_clock_does_not_double_count_observation(self):
        self.advance(BASE + 150)
        self.now = BASE + 120
        self.store.collect()
        self.advance(BASE + 420)
        self.reader.assert_not_called()
        self.assertEqual(self.summary()["analyzed_seconds"], 0)


class TestRecordingDatabase(unittest.TestCase):
    def test_reader_selects_only_overlapping_main_intervals_for_the_camera(self):
        with tempfile.TemporaryDirectory() as folder:
            database_path = Path(folder) / "recording database.db"
            with sqlite3.connect(database_path) as connection:
                connection.execute(
                    "CREATE TABLE recordings (camera TEXT, stream_type TEXT, "
                    "start_time REAL, end_time REAL)"
                )
                connection.executemany(
                    "INSERT INTO recordings VALUES (?, ?, ?, ?)",
                    [
                        ("front", "main", BASE - 5, BASE + 5),
                        ("front", "main", BASE + 5, BASE + 300),
                        ("front", "sub", BASE, BASE + 300),
                        ("other", "main", BASE, BASE + 300),
                        ("front", "main", BASE - 10, BASE),
                        ("front", "main", BASE + 300, BASE + 310),
                    ],
                )
            policy = config()
            policy.database.path = str(database_path)
            store = RecordingHealth(
                policy,
                threading.Event(),
                Path(folder) / "history.json",
                clock=lambda: BASE,
            )
            self.assertEqual(
                store._read_rows("front", BASE, BASE + 300),
                [(BASE - 5, BASE + 5), (BASE + 5, BASE + 300)],
            )

    def test_reader_does_not_create_a_missing_database(self):
        with tempfile.TemporaryDirectory() as folder:
            policy = config()
            missing = Path(folder) / "missing.db"
            policy.database.path = str(missing)
            store = RecordingHealth(
                policy,
                threading.Event(),
                Path(folder) / "history.json",
                clock=lambda: BASE,
            )
            with self.assertRaises(sqlite3.OperationalError):
                store._read_rows("front", BASE, BASE + 300)
            self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
