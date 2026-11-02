"""Tests that the fork's legacy `all` scene reads as upstream's `default`."""

import unittest
from unittest.mock import patch

from frigate.config import FrigateConfig
from frigate.config.camera.detect import DetectConfig
from frigate.detectors.detector_config import DEFAULT_SCENE, ModelConfig
from frigate.fork.legacy_scene import LEGACY_DEFAULT_SCENE, read_legacy_scene


class TestReadLegacyScene(unittest.TestCase):
    def test_legacy_catch_all_reads_as_default(self) -> None:
        self.assertEqual(read_legacy_scene(LEGACY_DEFAULT_SCENE), DEFAULT_SCENE)

    def test_other_values_pass_through(self) -> None:
        for value in ("default", "outdoor", "", None, 3):
            with self.subTest(value=value):
                self.assertEqual(read_legacy_scene(value), value)


@patch("frigate.detectors.detector_config.load_labels", return_value={})
class TestLegacySceneInConfig(unittest.TestCase):
    def _config(self, models: list[dict], scene: str | None) -> FrigateConfig:
        detect: dict = {"height": 1080, "width": 1920, "fps": 5}
        if scene is not None:
            detect["scene"] = scene

        return FrigateConfig(
            mqtt={"host": "mqtt"},
            models=models,
            cameras={
                "back": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": detect,
                }
            },
        )

    def test_model_config_reads_all_as_default(self, _labels) -> None:
        self.assertEqual(ModelConfig(scene="all").scene, DEFAULT_SCENE)

    def test_detect_config_reads_all_as_default(self, _labels) -> None:
        self.assertEqual(DetectConfig(scene="all").scene, DEFAULT_SCENE)

    def test_migrated_all_model_still_serves_other_scenes(self, _labels) -> None:
        config = self._config(
            [
                {"scene": "all", "devices": ["cpu"]},
                {"scene": "indoor", "devices": ["cpu"], "width": 300},
            ],
            "outdoor",
        )

        self.assertEqual(config.model_for_camera("back").scene, DEFAULT_SCENE)

    def test_camera_scene_all_uses_the_default_model(self, _labels) -> None:
        config = self._config(
            [
                {"scene": "default", "devices": ["cpu"]},
                {"scene": "indoor", "devices": ["cpu"], "width": 300},
            ],
            "all",
        )

        self.assertEqual(config.cameras["back"].detect.scene, DEFAULT_SCENE)
        self.assertEqual(config.model_for_camera("back").scene, DEFAULT_SCENE)


if __name__ == "__main__":
    unittest.main()
