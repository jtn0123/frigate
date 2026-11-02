"""B43 (upstream #24684): thumbnail data no longer copies the object's path."""

import unittest

import numpy as np

from frigate.config import FrigateConfig
from frigate.track.tracked_object import TrackedObject


def _config() -> FrigateConfig:
    return FrigateConfig(
        **{
            "mqtt": {"enabled": False},
            "cameras": {
                "front": {
                    "ffmpeg": {
                        "inputs": [{"path": "rtsp://test/front", "roles": ["detect"]}]
                    },
                    "detect": {"width": 320, "height": 240, "fps": 5},
                    "objects": {"track": ["person"]},
                }
            },
        }
    )


def _detection(when: float, x: int, score: float) -> dict:
    return {
        "id": "1.0-abc",
        "label": "person",
        "score": score,
        "score_history": [score] * 3,
        "box": (x - 20, 40, x + 20, 120),
        "centroid": (x, 80),
        "area": 3200,
        "ratio": 0.5,
        "region": (0, 0, 320, 240),
        "frame_time": when,
        "start_time": 0.0,
        "motionless_count": 0,
        "position_changes": 1,
        "attributes": [],
        "estimate_velocity": np.zeros((2, 2)),
    }


class TestThumbnailPayload(unittest.TestCase):
    def test_thumbnail_data_leaves_the_path_to_the_top_level(self):
        config = _config()
        obj = TrackedObject(
            config.model_for_camera("front"),
            config.cameras["front"],
            config.ui,
            {},
            _detection(0.0, 40, 0.8),
        )

        # a moving object with a rising score keeps getting better thumbnails
        for step, x in enumerate((60, 120, 180, 240), start=1):
            obj.update(float(step), _detection(float(step), x, 0.8 + step / 100), True)

        self.assertIsNotNone(obj.thumbnail_data)
        self.assertGreater(obj.thumbnail_data["frame_time"], 0.0)
        self.assertNotIn("path_data", obj.thumbnail_data)
        self.assertTrue(obj.to_dict()["path_data"])


if __name__ == "__main__":
    unittest.main()
