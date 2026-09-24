"""Fork (D54): the stored system metrics history."""

import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from frigate.stats.system_history import (
    TIERS,
    bucket_seconds,
    measurement,
    merge_samples,
    read_history,
    save_sample,
    select_metrics,
)

NOW = 1700000000


def snapshot(inference: float, cpu: str, gpu: str, updated: float) -> dict:
    """A stats snapshot with the fields the General tab graphs, and more."""
    return {
        "service": {"last_updated": updated, "version": "0.17.0"},
        "detectors": {
            "coral": {
                "inference_speed": inference,
                "detection_start": 0.0,
                "pid": 42,
                "cpu": cpu,
                "mem": "1.5",
            }
        },
        "gpu_usages": {"nvidia-gpu": {"vendor": "nvidia", "gpu": gpu, "mem": "10.00%"}},
        "processes": {"go2rtc": {"cpu": "2.0", "mem": "0.5", "pid": 7}},
        "cpu_usages": {"42": {"cmdline": "ffmpeg -i rtsp://user:pass@cam", "cpu": "1"}},
        "cameras": {"front": {"camera_fps": 5}},
    }


class TestSelectMetrics(unittest.TestCase):
    def test_keeps_only_the_graphed_fields(self):
        selected = select_metrics(snapshot(10.0, "3.0", "20.00%", NOW))

        self.assertEqual(
            sorted(selected),
            ["detectors", "gpu_usages", "processes", "service"],
        )
        self.assertEqual(selected["service"], {"last_updated": NOW})
        self.assertEqual(
            selected["detectors"]["coral"],
            {"inference_speed": 10.0, "cpu": "3.0", "mem": "1.5"},
        )
        self.assertEqual(selected["processes"]["go2rtc"], {"cpu": "2.0", "mem": "0.5"})

    def test_drops_process_command_lines(self):
        self.assertNotIn("cpu_usages", select_metrics(snapshot(10.0, "3.0", "", NOW)))

    def test_keeps_a_detector_without_optional_fields(self):
        stats = {"detectors": {"coral": {"inference_speed": 8.0}}}

        self.assertEqual(
            select_metrics(stats)["detectors"], {"coral": {"inference_speed": 8.0}}
        )


class TestMeasurement(unittest.TestCase):
    def test_reads_numbers_and_formatted_strings(self):
        self.assertEqual(measurement(10.5).value, 10.5)
        self.assertFalse(measurement(10.5).text)
        self.assertEqual(measurement("12.50%").suffix, "%")
        self.assertTrue(measurement("3.2").text)
        self.assertEqual(measurement("3.2").suffix, "")

    def test_rejects_what_is_not_a_measurement(self):
        for value in ("nvidia", "", None, True, float("nan"), {"a": 1}):
            self.assertIsNone(measurement(value), value)


class TestMergeSamples(unittest.TestCase):
    def test_averages_each_field_in_its_own_format(self):
        merged = merge_samples(
            [
                select_metrics(snapshot(10.0, "3.0", "20.00%", NOW)),
                select_metrics(snapshot(20.0, "5.0", "40.00%", NOW + 60)),
            ]
        )

        self.assertEqual(merged["detectors"]["coral"]["inference_speed"], 15.0)
        self.assertEqual(merged["detectors"]["coral"]["cpu"], "4.00")
        self.assertEqual(merged["gpu_usages"]["nvidia-gpu"]["gpu"], "30.00%")
        self.assertEqual(merged["gpu_usages"]["nvidia-gpu"]["vendor"], "nvidia")

    def test_averages_a_field_only_some_samples_have(self):
        merged = merge_samples(
            [
                {"detectors": {"coral": {"inference_speed": 10.0}}},
                {"detectors": {"coral": {"inference_speed": 20.0, "temperature": 50}}},
            ]
        )

        self.assertEqual(merged["detectors"]["coral"]["temperature"], 50.0)

    def test_keeps_a_gpu_that_reports_no_reading(self):
        merged = merge_samples(
            [{"gpu_usages": {"intel-gpu": {"vendor": "intel", "gpu": ""}}}] * 2
        )

        self.assertEqual(
            merged["gpu_usages"]["intel-gpu"], {"vendor": "intel", "gpu": ""}
        )

    def test_drops_a_value_that_is_never_a_measurement(self):
        self.assertEqual(merge_samples([{"npu_usages": {"rockchip": None}}]), {})


class TestBucketSeconds(unittest.TestCase):
    def test_every_window_fits_in_a_drawable_number_of_points(self):
        for window in (3600, 21600, 43200, 86400, 604800, 2592000):
            size = bucket_seconds(window)

            self.assertGreaterEqual(size, TIERS[0].seconds)
            self.assertLessEqual(window / size, 180)


class TestHistoryDatabase(unittest.TestCase):
    def setUp(self):
        self.dir = TemporaryDirectory()
        self.path = Path(self.dir.name) / "system-metrics-history.sqlite"
        self.addCleanup(self.dir.cleanup)

    def rows(self) -> list[tuple[int, int]]:
        with sqlite3.connect(self.path) as db:
            return db.execute(
                "SELECT resolution, bucket FROM samples ORDER BY resolution, bucket"
            ).fetchall()

    def test_reads_back_what_a_minute_stored(self):
        save_sample(snapshot(10.0, "3.0", "20.00%", NOW), 30, self.path, NOW)

        samples, resolution = read_history(3600, path=self.path, now=NOW)

        self.assertEqual(resolution, 60)
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["detectors"]["coral"]["inference_speed"], 10.0)
        self.assertEqual(samples[0]["service"]["last_updated"], (NOW // 60) * 60)

    def test_one_row_a_minute_however_often_it_is_called(self):
        for offset in (0, 10, 20):
            save_sample(
                snapshot(10.0, "3.0", "", NOW + offset), 30, self.path, NOW + offset
            )

        self.assertEqual(len(self.rows()), 1)

    def test_a_missing_database_is_an_empty_history(self):
        self.assertEqual(read_history(3600, path=self.path, now=NOW), ([], 60))

    def test_a_long_window_averages_minutes_into_one_bucket(self):
        started = (NOW // 300) * 300

        for minute in range(10):
            moment = started + minute * 60
            save_sample(snapshot(minute, "3.0", "", moment), 30, self.path, moment)

        samples, resolution = read_history(21600, path=self.path, now=started + 600)

        self.assertEqual(resolution, 300)
        self.assertEqual(len(samples), 2)
        self.assertEqual(samples[0]["detectors"]["coral"]["inference_speed"], 2.0)

    def test_minutes_roll_up_once_they_age_past_a_day(self):
        started = ((NOW - 90000) // 900) * 900

        for minute in range(15):
            moment = started + minute * 60
            save_sample(snapshot(minute, "3.0", "", moment), 30, self.path, moment)

        self.assertEqual(len(self.rows()), 15)

        save_sample(snapshot(0.0, "3.0", "", NOW), 30, self.path, NOW)

        self.assertEqual(self.rows(), [(60, NOW // 60), (900, started // 900)])

        with sqlite3.connect(self.path) as db:
            rolled = json.loads(
                db.execute(
                    "SELECT data FROM samples WHERE resolution = 900"
                ).fetchone()[0]
            )

        self.assertEqual(rolled["detectors"]["coral"]["inference_speed"], 7.0)

    def test_a_week_old_sample_ends_up_in_the_coarsest_tier(self):
        started = ((NOW - 8 * 86400) // 14400) * 14400

        for minute in range(15):
            moment = started + minute * 60
            save_sample(snapshot(minute, "3.0", "", moment), 30, self.path, moment)

        save_sample(snapshot(0.0, "3.0", "", NOW), 30, self.path, NOW)

        self.assertEqual(self.rows(), [(60, NOW // 60), (14400, started // 14400)])

    def test_an_open_target_bucket_keeps_its_minutes(self):
        # A minute that has aged out but whose 15 minute bucket has not yet
        # closed is left alone, so the bucket is written once, from all of it.
        started = ((NOW - 86400) // 900) * 900

        save_sample(snapshot(1.0, "3.0", "", started), 30, self.path, started)
        save_sample(snapshot(0.0, "3.0", "", NOW), 30, self.path, NOW)

        self.assertIn((60, started // 60), self.rows())

    def test_every_sample_carries_what_the_graphs_dereference(self):
        save_sample({"service": {"last_updated": NOW}}, 30, self.path, NOW)

        samples, _ = read_history(3600, path=self.path, now=NOW)

        self.assertEqual(samples[0]["detectors"], {})
        self.assertEqual(samples[0]["processes"], {})

    def test_retention_drops_what_is_older_than_it_keeps(self):
        old = NOW - 3 * 86400

        save_sample(snapshot(1.0, "3.0", "", old), 30, self.path, old)
        save_sample(snapshot(2.0, "3.0", "", NOW), 2, self.path, NOW)

        self.assertEqual(self.rows(), [(60, NOW // 60)])
