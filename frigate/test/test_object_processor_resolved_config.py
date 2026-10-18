"""B32 (upstream #24450): the object processor reads the camera config it
resolved, so a replay camera removed mid-frame cannot raise a KeyError."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from frigate.config import FrigateConfig
from frigate.track.object_processing import TrackedObjectProcessor


def camera_config():
    config = FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "replay": {
                    "ffmpeg": {
                        "inputs": [
                            {
                                "path": "rtsp://10.0.0.1:554/video",
                                "roles": ["detect", "record"],
                            }
                        ]
                    },
                    "record": {"enabled": True},
                    "snapshots": {"enabled": True},
                    "motion": {"mqtt_off_delay": 30},
                }
            },
        }
    )
    return config.cameras["replay"]


def tracked_object():
    return SimpleNamespace(
        false_positive=False,
        obj_data={"id": "event", "position_changes": 1},
        entered_zones=[],
        max_severity="alert",
        is_stationary=lambda: False,
    )


class TestResolvedCameraConfig(unittest.TestCase):
    def setUp(self):
        self.processor = TrackedObjectProcessor.__new__(TrackedObjectProcessor)
        # the replay camera has already been removed from the live config
        self.processor.config = SimpleNamespace(cameras={})
        self.processor.dispatcher = MagicMock()
        self.processor.last_motion_detected = {"replay": 1.0}
        self.camera = camera_config()

    def test_snapshot_and_clip_decisions_use_the_resolved_config(self):
        obj = tracked_object()

        self.assertTrue(self.processor.should_save_snapshot(self.camera, obj))
        self.assertTrue(self.processor.should_retain_recording(self.camera, obj))
        self.assertTrue(self.processor.should_mqtt_snapshot(self.camera.mqtt, obj))

    def test_motion_off_delay_uses_the_resolved_config(self):
        self.processor.update_mqtt_motion("replay", self.camera, 40.0, [])

        self.processor.dispatcher.publish.assert_called_once_with(
            "replay/motion", "OFF", retain=False
        )


if __name__ == "__main__":
    unittest.main()
