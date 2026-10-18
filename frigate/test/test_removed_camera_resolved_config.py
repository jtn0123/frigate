"""B32 (upstream #24450): stats and activity managers resolve each camera's
config once, so a camera removed at runtime is skipped instead of raising."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frigate.camera.activity_manager import (
    AudioActivityManager,
    CameraActivityManager,
)
from frigate.config import FrigateConfig
from frigate.stats.util import stats_snapshot


def camera_config():
    config = FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "front": {
                    "ffmpeg": {
                        "inputs": [
                            {
                                "path": "rtsp://10.0.0.1:554/video",
                                "roles": ["detect", "audio"],
                            }
                        ]
                    },
                    "detect": {"enabled": True, "fps": 5},
                    "audio": {"enabled": True},
                }
            },
        }
    )
    return config.cameras["front"]


def value(v):
    return SimpleNamespace(value=v)


def camera_metrics():
    return SimpleNamespace(
        camera_fps=value(5.0),
        process_fps=value(5.0),
        skipped_fps=value(0.0),
        detection_fps=value(1.0),
        process_pid=value(10),
        ffmpeg_pid=value(11),
        capture_process_pid=value(12),
        reconnects_last_hour=value(0),
        stalls_last_hour=value(0),
        restart_events=[],
        outage_events=[],
        audio_rms=value(0.0),
        audio_dBFS=value(0.0),
        hwaccel_fallback=value(0),
        hwaccel_fallback_since=value(0),
        outage_since=value(0),
        watchdog_heartbeat=value(0),
    )


class TestStatsSnapshotRemovedCamera(unittest.TestCase):
    def test_metrics_of_a_removed_camera_are_skipped(self):
        config = SimpleNamespace(
            cameras={"front": camera_config()},
            telemetry=SimpleNamespace(stats=SimpleNamespace(network_bandwidth=False)),
        )
        stats_tracking = {
            # "gone" was removed from the config but still has metrics
            "camera_metrics": {"front": camera_metrics(), "gone": camera_metrics()},
            "started": 0,
            "latest_frigate_version": None,
            "processes": {},
        }

        with (
            patch("frigate.stats.util.get_detector_stats", return_value={}),
            patch("frigate.stats.util.embeddings_stats", return_value=None),
            patch("frigate.stats.util.shutil.disk_usage", side_effect=OSError),
            patch("frigate.stats.util.calculate_shm_requirements", return_value={}),
        ):
            stats = stats_snapshot(config, stats_tracking, MagicMock())

        self.assertEqual(list(stats["cameras"]), ["front"])
        self.assertEqual(stats["cameras"]["front"]["expected_fps"], 5)
        self.assertTrue(stats["cameras"]["front"]["detection_enabled"])
        self.assertEqual(stats["camera_fps"], 5.0)


class TestActivityManagersRemovedCamera(unittest.TestCase):
    def test_camera_activity_skips_removed_and_inits_added_cameras(self):
        manager = CameraActivityManager.__new__(CameraActivityManager)
        manager.config = SimpleNamespace(cameras={"front": camera_config()})
        manager.publish = MagicMock()
        manager.last_camera_activity = {}
        manager.camera_all_object_counts = {}
        manager.camera_active_object_counts = {}
        manager.zone_all_object_counts = {}
        manager.zone_active_object_counts = {}
        manager.all_zone_labels = {}
        manager.config_subscriber = MagicMock(**{"check_for_updates.return_value": {}})

        manager.update_activity({"gone": {"objects": []}, "front": {"objects": []}})

        self.assertIn("front", manager.camera_all_object_counts)
        self.assertNotIn("gone", manager.camera_all_object_counts)

    def test_audio_activity_skips_removed_and_inits_added_cameras(self):
        manager = AudioActivityManager.__new__(AudioActivityManager)
        manager.config = SimpleNamespace(cameras={"front": camera_config()})
        manager.publish = MagicMock()
        manager.current_audio_detections = {}
        manager.event_metadata_publisher = MagicMock()

        manager.update_activity(
            {
                "gone": {"detections": [("speech", 0.9)]},
                "front": {"detections": [("speech", 0.9)]},
            }
        )

        self.assertEqual(list(manager.current_audio_detections), ["front"])
        manager.publish.assert_any_call("front/audio/speech", "ON")
        manager.publish.assert_any_call("front/audio/all", "ON")


if __name__ == "__main__":
    unittest.main()
