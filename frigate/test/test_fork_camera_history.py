"""Tests for the per-camera health history store (fork UI131)."""

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from frigate.stats.camera_history import (
    BUCKET_SECONDS,
    MAX_CAMERAS,
    MAX_INCIDENTS_PER_CAMERA,
    RANGE_SPEC,
    WINDOW_SECONDS,
    Bucket,
    CameraHistory,
    classify,
)

# A fixed clock keeps bucket slots stable across runs.
NOW = 1_789_900_000.0


def snapshot(**cameras: dict[str, Any]) -> dict[str, Any]:
    return {"cameras": cameras}


def camera(
    fps: float = 5.0,
    expected: float = 5.0,
    outage_since: float | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "camera_fps": fps,
        "expected_fps": expected,
        "outage_since": outage_since,
        **extra,
    }


class TestClassify(unittest.TestCase):
    def test_full_rate_is_ok(self):
        self.assertEqual(classify(5.0, 5.0, None), "ok")

    def test_half_rate_is_degraded(self):
        self.assertEqual(classify(2.0, 5.0, None), "degraded")

    def test_no_frames_is_offline(self):
        self.assertEqual(classify(0.0, 5.0, None), "offline")

    def test_open_outage_is_offline_even_with_frames(self):
        self.assertEqual(classify(5.0, 5.0, NOW - 60), "offline")

    def test_unknown_expected_rate_never_degrades(self):
        self.assertEqual(classify(1.0, 0.0, None), "ok")


class TestBucket(unittest.TestCase):
    def test_round_trips_through_encode(self):
        bucket = Bucket()
        bucket.add(5.0, 5.0, "ok")
        bucket.add(1.0, 5.0, "degraded")
        restored = Bucket.decode(bucket.encode())
        assert restored is not None
        self.assertEqual(restored.samples, 2)
        self.assertEqual(restored.degraded, 1)
        self.assertEqual(restored.fps_min, 1.0)
        self.assertEqual(restored.mean_fps, 3.0)

    def test_empty_bucket_round_trips_without_a_minimum(self):
        restored = Bucket.decode(Bucket().encode())
        assert restored is not None
        self.assertIsNone(restored.fps_min)
        self.assertIsNone(restored.mean_fps)
        self.assertEqual(restored.state, "none")

    def test_decode_rejects_malformed_rows(self):
        self.assertIsNone(Bucket.decode("nope"))
        self.assertIsNone(Bucket.decode([1, 2, 3]))
        self.assertIsNone(Bucket.decode([1, 2, 3, 4, 5, "x"]))

    def test_worst_state_wins_within_a_bucket(self):
        bucket = Bucket()
        bucket.add(5.0, 5.0, "ok")
        bucket.add(0.0, 5.0, "offline")
        bucket.add(2.0, 5.0, "degraded")
        self.assertEqual(bucket.state, "offline")


class HistoryTestCase(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / ".camera_history.json"
        self.addCleanup(self._dir.cleanup)


class TestRecord(HistoryTestCase):
    def test_samples_in_one_slot_share_a_bucket(self):
        store = CameraHistory(path=self.path)
        for offset in (0, 30, 60):
            store.record(snapshot(front=camera()), now=NOW + offset)
        data = store.read("1h", now=NOW + 60)
        self.assertEqual(data["cameras"]["front"]["samples"], 3)

    def test_samples_across_slots_land_in_different_cells(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        store.record(snapshot(front=camera(fps=0.0)), now=NOW + BUCKET_SECONDS)
        states = store.read("1h", now=NOW + BUCKET_SECONDS)["cameras"]["front"][
            "states"
        ]
        self.assertEqual(states[-2:], ["ok", "offline"])

    def test_ignores_a_snapshot_without_cameras(self):
        store = CameraHistory(path=self.path)
        store.record({}, now=NOW)
        store.record({"cameras": "nope"}, now=NOW)
        self.assertEqual(store.read("1h", now=NOW)["cameras"], {})

    def test_ignores_a_camera_that_is_not_a_mapping(self):
        store = CameraHistory(path=self.path)
        store.record({"cameras": {"front": "nope"}}, now=NOW)
        self.assertEqual(store.read("1h", now=NOW)["cameras"], {})

    def test_missing_frame_rate_counts_as_offline(self):
        store = CameraHistory(path=self.path)
        store.record({"cameras": {"front": {}}}, now=NOW)
        self.assertEqual(store.read("1h", now=NOW)["cameras"]["front"]["uptime"], 0.0)

    def test_stops_adding_cameras_past_the_cap(self):
        store = CameraHistory(path=self.path)
        names = {f"cam{i}": camera() for i in range(MAX_CAMERAS + 5)}
        store.record(snapshot(**names), now=NOW)
        self.assertEqual(len(store.read("1h", now=NOW)["cameras"]), MAX_CAMERAS)

    def test_drops_buckets_older_than_the_window(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        later = NOW + WINDOW_SECONDS + BUCKET_SECONDS * 2
        store.record(snapshot(front=camera()), now=later)
        data = store.read("7d", now=later)
        self.assertEqual(data["cameras"]["front"]["samples"], 1)


class TestRead(HistoryTestCase):
    def test_every_range_returns_its_cell_count(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        for key, (window, cells) in RANGE_SPEC.items():
            with self.subTest(range=key):
                data = store.read(key, now=NOW)
                series = data["cameras"]["front"]
                self.assertEqual(len(series["states"]), cells)
                self.assertEqual(len(series["fps"]), cells)
                self.assertEqual(data["cell_seconds"], window // cells)

    def test_unknown_range_falls_back_to_the_default(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        self.assertEqual(store.read("99y", now=NOW)["range"], "24h")

    def test_cells_without_samples_report_no_state(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        series = store.read("24h", now=NOW)["cameras"]["front"]
        self.assertEqual(series["states"][0], "none")
        self.assertIsNone(series["fps"][0])
        self.assertEqual(series["states"][-1], "ok")

    def test_uptime_counts_the_share_of_samples_that_were_not_offline(self):
        store = CameraHistory(path=self.path)
        for _ in range(3):
            store.record(snapshot(front=camera()), now=NOW)
        store.record(snapshot(front=camera(fps=0.0)), now=NOW)
        self.assertEqual(store.read("1h", now=NOW)["cameras"]["front"]["uptime"], 75.0)

    def test_downtime_scales_offline_samples_to_the_window(self):
        store = CameraHistory(path=self.path)
        for _ in range(3):
            store.record(snapshot(front=camera()), now=NOW)
        store.record(snapshot(front=camera(fps=0.0)), now=NOW)
        series = store.read("1h", now=NOW)["cameras"]["front"]
        self.assertEqual(series["downtime"], 900)

    def test_a_camera_with_no_samples_reports_full_uptime(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW - WINDOW_SECONDS * 2)
        series = store.read("1h", now=NOW)["cameras"]["front"]
        self.assertEqual(series["samples"], 0)
        self.assertEqual(series["uptime"], 100.0)
        self.assertEqual(series["downtime"], 0)

    def test_mean_frame_rate_is_averaged_across_a_cell(self):
        store = CameraHistory(path=self.path)
        # 24h cells are an hour wide, so both slots fall in the last cell.
        store.record(snapshot(front=camera(fps=4.0)), now=NOW)
        store.record(snapshot(front=camera(fps=2.0)), now=NOW + BUCKET_SECONDS)
        series = store.read("24h", now=NOW + BUCKET_SECONDS)["cameras"]["front"]
        self.assertEqual(series["fps"][-1], 3.0)

    def test_cameras_come_back_sorted(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(zulu=camera(), alpha=camera()), now=NOW)
        self.assertEqual(list(store.read("1h", now=NOW)["cameras"]), ["alpha", "zulu"])


class TestIncidents(HistoryTestCase):
    def test_an_open_outage_is_recorded_once(self):
        store = CameraHistory(path=self.path)
        for offset in (0, 15, 30):
            store.record(
                snapshot(front=camera(fps=0.0, outage_since=NOW - 60)),
                now=NOW + offset,
            )
        incidents = store.read("1h", now=NOW + 30)["cameras"]["front"]["incidents"]
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["kind"], "outage")
        self.assertIsNone(incidents[0]["end"])

    def test_a_recovered_outage_gets_an_end(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera(fps=0.0, outage_since=NOW - 60)), now=NOW)
        store.record(
            snapshot(
                front=camera(
                    recent_outages=[
                        {
                            "time": NOW,
                            "state": "recovered",
                            "since": NOW - 60,
                            "duration": 60,
                            "reason": "stream returned",
                        }
                    ]
                )
            ),
            now=NOW + 15,
        )
        incidents = store.read("1h", now=NOW + 15)["cameras"]["front"]["incidents"]
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["end"], NOW)

    def test_restarts_are_kept_with_their_kind_and_message(self):
        store = CameraHistory(path=self.path)
        store.record(
            snapshot(
                front=camera(
                    recent_restarts=[
                        {
                            "time": NOW - 30,
                            "role": "detect",
                            "kind": "stalled",
                            "message": "watchdog restarted the stream",
                        }
                    ]
                )
            ),
            now=NOW,
        )
        incidents = store.read("1h", now=NOW)["cameras"]["front"]["incidents"]
        self.assertEqual(incidents[0]["kind"], "restart:stalled")
        self.assertEqual(incidents[0]["reason"], "watchdog restarted the stream")

    def test_the_same_restart_is_not_stored_twice(self):
        store = CameraHistory(path=self.path)
        event = {
            "time": NOW - 30,
            "role": "detect",
            "kind": "other",
            "message": "restarted",
        }
        for offset in (0, 15, 30):
            store.record(
                snapshot(front=camera(recent_restarts=[event])), now=NOW + offset
            )
        incidents = store.read("1h", now=NOW + 30)["cameras"]["front"]["incidents"]
        self.assertEqual(len(incidents), 1)

    def test_incidents_are_capped_per_camera(self):
        store = CameraHistory(path=self.path)
        restarts = [
            {"time": NOW - i, "role": "detect", "kind": "other", "message": "r"}
            for i in range(MAX_INCIDENTS_PER_CAMERA + 20)
        ]
        store.record(snapshot(front=camera(recent_restarts=restarts)), now=NOW)
        incidents = store.read("1h", now=NOW)["cameras"]["front"]["incidents"]
        self.assertEqual(len(incidents), MAX_INCIDENTS_PER_CAMERA)

    def test_incidents_outside_the_window_are_left_out(self):
        store = CameraHistory(path=self.path)
        store.record(
            snapshot(
                front=camera(
                    recent_restarts=[
                        {
                            "time": NOW - 4 * 3600,
                            "role": "detect",
                            "kind": "other",
                            "message": "old",
                        }
                    ]
                )
            ),
            now=NOW,
        )
        self.assertEqual(store.read("1h", now=NOW)["cameras"]["front"]["incidents"], [])
        self.assertEqual(
            len(store.read("24h", now=NOW)["cameras"]["front"]["incidents"]), 1
        )

    def test_malformed_incident_rows_are_skipped(self):
        store = CameraHistory(path=self.path)
        store.record(
            snapshot(
                front=camera(
                    recent_outages="nope",
                    recent_restarts=[{"role": "detect"}, "nope"],
                )
            ),
            now=NOW,
        )
        self.assertEqual(store.read("1h", now=NOW)["cameras"]["front"]["incidents"], [])


class TestPersistence(HistoryTestCase):
    def test_buckets_survive_a_restart(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        store.flush()

        reopened = CameraHistory(path=self.path)
        series = reopened.read("1h", now=NOW)["cameras"]["front"]
        self.assertEqual(series["samples"], 1)
        self.assertEqual(series["states"][-1], "ok")

    def test_flush_writes_nothing_when_no_sample_arrived(self):
        CameraHistory(path=self.path).flush()
        self.assertFalse(self.path.exists())

    def test_flush_replaces_the_file_without_leaving_temporaries(self):
        store = CameraHistory(path=self.path)
        store.record(snapshot(front=camera()), now=NOW)
        store.flush()
        store.record(snapshot(front=camera()), now=NOW + BUCKET_SECONDS)
        store.flush()
        self.assertEqual([p.name for p in self.path.parent.iterdir()], [self.path.name])

    def test_an_unreadable_file_is_ignored(self):
        self.path.write_text("{ not json")
        self.assertEqual(
            CameraHistory(path=self.path).read("1h", now=NOW)["cameras"], {}
        )

    def test_an_oversized_file_is_ignored(self):
        self.path.write_text(" " * (8 * 1024 * 1024 + 1))
        self.assertEqual(
            CameraHistory(path=self.path).read("1h", now=NOW)["cameras"], {}
        )

    def test_malformed_entries_are_dropped_on_load(self):
        self.path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "cameras": {
                        "front": {"buckets": {"x": [1, 1, 1, 1, 0, 0]}},
                        "side": "nope",
                        "back": {"buckets": {"1": "nope"}, "incidents": ["nope"]},
                    },
                }
            )
        )
        data = CameraHistory(path=self.path).read("1h", now=NOW)["cameras"]
        self.assertEqual(data["front"]["samples"], 0)
        self.assertNotIn("side", data)
        self.assertEqual(data["back"]["incidents"], [])


class TestNumericHistory(HistoryTestCase):
    def test_nonfinite_and_non_numeric_frame_rates_are_offline(self):
        for value in (float("nan"), float("inf"), float("-inf"), True, "5", None):
            with self.subTest(value=value):
                store = CameraHistory(path=self.path)
                store.record(snapshot(front={"camera_fps": value}), now=NOW)
                series = store.read("1h", now=NOW)["cameras"]["front"]
                self.assertEqual(series["states"][-1], "offline")
                self.assertEqual(series["fps"][-1], 0.0)

    def test_load_retains_only_valid_incidents_and_recent_buckets(self):
        slot = int(NOW // BUCKET_SECONDS)
        self.path.write_text(
            json.dumps(
                {
                    "cameras": {
                        "front": {
                            "buckets": {
                                str(slot): [1, 5, 5, 5, 0, 0],
                                "0": [1, 1, 1, 1, 0, 0],
                                str(slot - 1): ["bad", 1, 1, 1, 0, 0],
                            },
                            "incidents": [
                                None,
                                {},
                                {"start": NOW},
                                {"kind": "outage", "start": "bad"},
                                {"kind": "outage", "start": NOW - 10, "end": NOW},
                            ],
                        }
                    }
                }
            )
        )
        store = CameraHistory(path=self.path)
        series = store.read("1h", now=NOW)["cameras"]["front"]
        self.assertEqual(series["samples"], 1)
        self.assertEqual(len(series["incidents"]), 1)
        self.assertEqual(series["incidents"][0]["end"], NOW)

    def test_snapshot_without_camera_mapping_is_ignored(self):
        for payload in ([], None, {}, {"cameras": []}):
            with self.subTest(payload=payload):
                self.path.write_text(json.dumps(payload))
                self.assertEqual(
                    CameraHistory(path=self.path).read("1h", now=NOW)["cameras"], {}
                )

    def test_window_includes_spanning_outages_but_not_old_closed_ones(self):
        self.path.write_text(
            json.dumps(
                {
                    "cameras": {
                        "front": {
                            "incidents": [
                                {
                                    "kind": "outage",
                                    "start": NOW - 7200,
                                    "end": NOW - 6000,
                                },
                                {
                                    "kind": "outage",
                                    "start": NOW - 7200,
                                    "end": NOW - 30,
                                },
                                {"kind": "outage", "start": NOW - 7200},
                            ]
                        }
                    }
                }
            )
        )
        incidents = CameraHistory(path=self.path).read("1h", now=NOW)["cameras"][
            "front"
        ]["incidents"]
        self.assertEqual(len(incidents), 2)
        self.assertEqual([item["end"] for item in incidents], [NOW - 30, None])
