"""Tests for the fork's Prometheus metrics (I59)."""

import tempfile
import unittest
from pathlib import Path

from prometheus_client.parser import text_string_to_metric_families

from frigate.stats.fork_prometheus import (
    camera_up,
    fork_metrics,
    number,
    read_cgroup,
)

NOW = 1_790_000_000


def camera(**overrides: object) -> dict:
    return {
        "camera_fps": 5.0,
        "expected_fps": 5,
        "skipped_pct": 1.5,
        "outage_since": None,
        "outages_24h": 0,
        "restarts_24h": 3,
        "restart_kinds_24h": {"connection": 2, "other": 1},
        "reconnects_last_hour": 2,
        "stalls_last_hour": 0,
        "connection_quality": "fair",
        "hwaccel_fallback": False,
        "watchdog_age": 1.2,
        **overrides,
    }


def samples(text: bytes) -> dict[tuple[str, tuple[tuple[str, str], ...]], float]:
    found = {}
    for family in text_string_to_metric_families(text.decode()):
        for sample in family.samples:
            found[(sample.name, tuple(sorted(sample.labels.items())))] = sample.value
    return found


def get(found: dict, metric: str, /, **labels: str) -> float:
    return found[(metric, tuple(sorted(labels.items())))]


class TestCameraMetrics(unittest.TestCase):
    def render(self, **cameras: dict) -> dict:
        stats = {"cameras": cameras, "service": {"last_updated": NOW}}
        return samples(fork_metrics(stats, cgroup={}))

    def test_healthy_camera(self) -> None:
        found = self.render(doorbell=camera())

        self.assertEqual(get(found, "frigate_camera_up", camera_name="doorbell"), 1)
        self.assertEqual(
            get(found, "frigate_camera_outage_seconds", camera_name="doorbell"), 0
        )
        self.assertEqual(
            get(found, "frigate_camera_expected_fps", camera_name="doorbell"), 5
        )
        self.assertEqual(
            get(found, "frigate_camera_skipped_percent", camera_name="doorbell"), 1.5
        )
        self.assertEqual(
            get(found, "frigate_camera_restarts_24h", camera_name="doorbell"), 3
        )
        self.assertEqual(
            get(
                found,
                "frigate_camera_restarts_by_kind_24h",
                camera_name="doorbell",
                kind="connection",
            ),
            2,
        )
        self.assertEqual(
            get(found, "frigate_camera_reconnects_last_hour", camera_name="doorbell"),
            2,
        )
        self.assertEqual(
            get(found, "frigate_camera_hwaccel_fallback", camera_name="doorbell"), 0
        )
        self.assertEqual(
            get(found, "frigate_camera_watchdog_age_seconds", camera_name="doorbell"),
            1.2,
        )

    def test_quality_is_one_series_per_state(self) -> None:
        found = self.render(doorbell=camera())

        values = {
            quality: get(
                found,
                "frigate_camera_connection_quality",
                camera_name="doorbell",
                quality=quality,
            )
            for quality in ("excellent", "fair", "poor", "unusable")
        }
        self.assertEqual(values, {"excellent": 0, "fair": 1, "poor": 0, "unusable": 0})

    def test_camera_in_an_outage_is_down_with_its_duration(self) -> None:
        found = self.render(doorbell=camera(outage_since=NOW - 600, outages_24h=1))

        self.assertEqual(get(found, "frigate_camera_up", camera_name="doorbell"), 0)
        self.assertEqual(
            get(found, "frigate_camera_outage_seconds", camera_name="doorbell"), 600
        )
        self.assertEqual(
            get(found, "frigate_camera_outages_24h", camera_name="doorbell"), 1
        )

    def test_camera_without_frames_is_down(self) -> None:
        found = self.render(doorbell=camera(camera_fps=0.0))

        self.assertEqual(get(found, "frigate_camera_up", camera_name="doorbell"), 0)

    def test_unknown_values_are_left_out(self) -> None:
        found = self.render(
            doorbell=camera(
                watchdog_age=None,
                connection_quality="new",
                hwaccel_fallback=None,
                restart_kinds_24h=None,
                expected_fps=float("nan"),
            ),
            broken="not a mapping",
        )

        names = {name for name, _ in found}
        self.assertNotIn("frigate_camera_watchdog_age_seconds", names)
        self.assertNotIn("frigate_camera_connection_quality", names)
        self.assertNotIn("frigate_camera_hwaccel_fallback", names)
        self.assertNotIn("frigate_camera_restarts_by_kind_24h", names)
        self.assertNotIn("frigate_camera_expected_fps", names)
        self.assertFalse(any("broken" in str(labels) for _, labels in found))

    def test_no_service_time_means_no_outage_duration(self) -> None:
        found = samples(fork_metrics({"cameras": {"doorbell": camera()}}, cgroup={}))

        self.assertNotIn("frigate_camera_outage_seconds", {name for name, _ in found})

    def test_empty_stats_render_nothing(self) -> None:
        self.assertEqual(fork_metrics({}, cgroup={}), b"")


class TestOtherMetrics(unittest.TestCase):
    def test_uptime_ratio_per_window(self) -> None:
        history = {
            "range": "24h",
            "cameras": {
                "doorbell": {"uptime": 87.5, "samples": 40},
                "new": {"uptime": 100.0, "samples": 0},
                "odd": "x",
            },
        }

        found = samples(fork_metrics({}, history=history, cgroup={}))

        self.assertEqual(
            get(
                found,
                "frigate_camera_uptime_ratio",
                camera_name="doorbell",
                window="24h",
            ),
            0.875,
        )
        self.assertEqual(len(found), 1)

    def test_go2rtc_streams(self) -> None:
        state = {
            "available": True,
            "cameras": {
                "doorbell": {
                    "streams": [
                        {
                            "name": "doorbell",
                            "connected": True,
                            "bytes_received": 97955227,
                            "consumers": 1,
                            "source": "ffmpeg:http://10.0.0.5",
                        },
                        {
                            "name": "doorbell_sub",
                            "connected": False,
                            "bytes_received": 0,
                            "consumers": 0,
                        },
                    ]
                },
                "odd": "x",
            },
        }

        text = fork_metrics({}, go2rtc=state, cgroup={})
        found = samples(text)

        self.assertEqual(get(found, "frigate_go2rtc_available"), 1)
        self.assertEqual(
            get(
                found,
                "frigate_go2rtc_stream_connected",
                camera_name="doorbell",
                stream="doorbell_sub",
            ),
            0,
        )
        self.assertEqual(
            get(
                found,
                "frigate_go2rtc_stream_received_bytes",
                camera_name="doorbell",
                stream="doorbell",
            ),
            97955227,
        )
        self.assertEqual(
            get(
                found,
                "frigate_go2rtc_stream_consumers",
                camera_name="doorbell",
                stream="doorbell",
            ),
            1,
        )
        # the source never becomes a label
        self.assertNotIn(b"10.0.0.5", text)

    def test_camera_ping(self) -> None:
        found = samples(
            fork_metrics(
                {},
                cgroup={},
                ping={
                    "front_door": {
                        "reachable": True,
                        "ms": 12.5,
                        "loss": 0.33,
                        "method": "icmp",
                    },
                    "garage": {
                        "reachable": False,
                        "ms": None,
                        "loss": 1.0,
                        "method": "tcp",
                    },
                },
            )
        )

        self.assertEqual(
            get(found, "frigate_camera_ping_up", camera_name="front_door"), 1
        )
        self.assertEqual(
            get(found, "frigate_camera_ping_seconds", camera_name="front_door"), 0.0125
        )
        self.assertEqual(
            get(found, "frigate_camera_ping_loss_ratio", camera_name="front_door"), 0.33
        )
        self.assertEqual(get(found, "frigate_camera_ping_up", camera_name="garage"), 0)
        self.assertEqual(
            get(found, "frigate_camera_ping_loss_ratio", camera_name="garage"), 1
        )
        # no round trip to report for a camera that did not answer
        self.assertNotIn(
            ("frigate_camera_ping_seconds", (("camera_name", "garage"),)), found
        )

    def test_go2rtc_down(self) -> None:
        found = samples(
            fork_metrics({}, go2rtc={"available": False, "cameras": {}}, cgroup={})
        )

        self.assertEqual(found, {("frigate_go2rtc_available", ()): 0})

    def test_enrichment_speeds_and_rates(self) -> None:
        stats = {
            "embeddings": {
                "face_recognition_speed": 42.0,
                "face_recognition": 1.5,
                "vehicle_type_classification_events_per_second": 0.25,
                "face_recognition_device": "GPU",
                "broken_speed": None,
            }
        }

        found = samples(fork_metrics(stats, cgroup={}))

        self.assertAlmostEqual(
            get(found, "frigate_enrichment_speed_seconds", name="face_recognition"),
            0.042,
        )
        self.assertEqual(
            get(found, "frigate_enrichment_per_second", name="face_recognition"), 1.5
        )
        self.assertEqual(
            get(
                found,
                "frigate_enrichment_per_second",
                name="vehicle_type_classification",
            ),
            0.25,
        )
        self.assertEqual(len(found), 3)

    def test_container_memory_and_host_pressure(self) -> None:
        pressure = {
            "status": "connected",
            "scopes": [
                {
                    "scope": "container",
                    "id": "106",
                    "memory_bytes": 9.0e9,
                    "oom_kills": 1,
                    "cpu_percent": None,
                }
            ],
        }
        cgroup = {"memory_bytes": 1.6e10, "limit_bytes": 1.7e10, "oom_kills": 1.0}

        found = samples(fork_metrics({}, pressure=pressure, cgroup=cgroup))

        self.assertEqual(get(found, "frigate_container_memory_bytes"), 1.6e10)
        self.assertEqual(get(found, "frigate_container_memory_limit_bytes"), 1.7e10)
        self.assertEqual(get(found, "frigate_container_oom_kills"), 1)
        self.assertEqual(
            get(found, "frigate_server_oom_kills", scope="container", id="106"), 1
        )
        self.assertEqual(
            get(found, "frigate_server_memory_bytes", scope="container", id="106"),
            9.0e9,
        )
        self.assertNotIn("frigate_server_cpu_percent", {name for name, _ in found})

    def test_pressure_without_scopes(self) -> None:
        self.assertEqual(
            fork_metrics({}, pressure={"status": "not_connected"}, cgroup={}), b""
        )


class TestReadCgroup(unittest.TestCase):
    def test_reads_use_limit_and_kills(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory / "memory.current").write_text("16828973056\n")
            (directory / "memory.max").write_text("17179869184\n")
            (directory / "memory.events").write_text(
                "low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n"
            )

            self.assertEqual(
                read_cgroup(directory),
                {
                    "memory_bytes": 16828973056.0,
                    "limit_bytes": 17179869184.0,
                    "oom_kills": 1.0,
                },
            )

    def test_no_limit_and_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory / "memory.current").write_text("1024\n")
            (directory / "memory.max").write_text("max\n")

            self.assertEqual(read_cgroup(directory), {"memory_bytes": 1024.0})
            self.assertEqual(read_cgroup(directory / "absent"), {})

    def test_default_directory_is_read_when_no_figures_are_given(self) -> None:
        # whatever this machine has, rendering must not fail
        self.assertIsInstance(fork_metrics({}), bytes)


class TestHelpers(unittest.TestCase):
    def test_number(self) -> None:
        self.assertEqual(number(3), 3.0)
        self.assertIsNone(number(True))
        self.assertIsNone(number("3"))
        self.assertIsNone(number(float("inf")))

    def test_camera_up(self) -> None:
        self.assertTrue(camera_up({"camera_fps": 5.0}))
        self.assertFalse(camera_up({"camera_fps": 0.05}))
        self.assertFalse(camera_up({"camera_fps": 5.0, "outage_since": 1.0}))
        self.assertFalse(camera_up({}))


if __name__ == "__main__":
    unittest.main()
