import datetime
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from frigate.config import FrigateConfig
from frigate.output.preview import (
    PREVIEW_CACHE_DIR,
    PREVIEW_FRAME_TYPE,
    PreviewRecorder,
    get_most_recent_preview_frame,
)


class TestPreviewRecorderStartupScan(unittest.TestCase):
    """D33: the startup scan takes only its own camera's frames."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.frames = os.path.join(tmp.name, "cache", "preview_frames")
        os.makedirs(self.frames)
        for target, value in (
            ("CACHE_DIR", os.path.join(tmp.name, "cache")),
            ("PREVIEW_CACHE_DIR", self.frames),
            ("CLIPS_DIR", os.path.join(tmp.name, "clips")),
        ):
            patcher = patch(f"frigate.output.preview.{target}", value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch("frigate.output.preview.InterProcessRequestor")
        patcher.start()
        self.addCleanup(patcher.stop)

    def frame(self, camera, ts):
        path = os.path.join(self.frames, f"preview_{camera}-{ts}.{PREVIEW_FRAME_TYPE}")
        with open(path, "w") as f:
            f.write("frame")
        return path

    def test_cameras_whose_names_extend_another_are_left_alone(self):
        camera = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
            },
            "detect": {"width": 640, "height": 360, "fps": 5},
        }
        config = FrigateConfig(
            mqtt={"host": "mqtt"},
            cameras={"cam": camera, "cam-1": camera, "cam-2": camera},
        )
        hour = (
            datetime.datetime.now(datetime.UTC)
            .replace(minute=0, second=0, microsecond=0)
            .timestamp()
        )
        old = self.frame("cam", hour - 10)
        own = self.frame("cam", hour + 1.5)
        other_1 = self.frame("cam-1", hour + 2.5)
        other_2 = self.frame("cam-2", hour + 3.5)

        recorder = PreviewRecorder(config.cameras["cam"])

        self.assertEqual(recorder.output_frames, [hour + 1.5])
        self.assertEqual(recorder.start_time, hour + 1.5)
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(own))
        self.assertTrue(os.path.exists(other_1))
        self.assertTrue(os.path.exists(other_2))


class TestPreviewLoader(unittest.TestCase):
    def setUp(self):
        if os.path.exists(PREVIEW_CACHE_DIR):
            shutil.rmtree(PREVIEW_CACHE_DIR)
        os.makedirs(PREVIEW_CACHE_DIR)

    def tearDown(self):
        if os.path.exists(PREVIEW_CACHE_DIR):
            shutil.rmtree(PREVIEW_CACHE_DIR)

    def test_get_most_recent_preview_frame_missing(self):
        self.assertIsNone(get_most_recent_preview_frame("test_camera"))

    def test_get_most_recent_preview_frame_exists(self):
        camera = "test_camera"
        # create dummy preview files
        for ts in ["1000.0", "2000.0", "1500.0"]:
            with open(
                os.path.join(
                    PREVIEW_CACHE_DIR, f"preview_{camera}-{ts}.{PREVIEW_FRAME_TYPE}"
                ),
                "w",
            ) as f:
                f.write(f"test_{ts}")

        expected_path = os.path.join(
            PREVIEW_CACHE_DIR, f"preview_{camera}-2000.0.{PREVIEW_FRAME_TYPE}"
        )
        self.assertEqual(get_most_recent_preview_frame(camera), expected_path)

    def test_get_most_recent_preview_frame_before(self):
        camera = "test_camera"
        # create dummy preview files
        for ts in ["1000.0", "2000.0"]:
            with open(
                os.path.join(
                    PREVIEW_CACHE_DIR, f"preview_{camera}-{ts}.{PREVIEW_FRAME_TYPE}"
                ),
                "w",
            ) as f:
                f.write(f"test_{ts}")

        # Test finding frame before or at 1500
        expected_path = os.path.join(
            PREVIEW_CACHE_DIR, f"preview_{camera}-1000.0.{PREVIEW_FRAME_TYPE}"
        )
        self.assertEqual(
            get_most_recent_preview_frame(camera, before=1500.0), expected_path
        )

        # Test finding frame before or at 999
        self.assertIsNone(get_most_recent_preview_frame(camera, before=999.0))

    def test_get_most_recent_preview_frame_other_camera(self):
        camera = "test_camera"
        other_camera = "other_camera"
        with open(
            os.path.join(
                PREVIEW_CACHE_DIR, f"preview_{other_camera}-3000.0.{PREVIEW_FRAME_TYPE}"
            ),
            "w",
        ) as f:
            f.write("test")

        self.assertIsNone(get_most_recent_preview_frame(camera))

    def test_get_most_recent_preview_frame_no_directory(self):
        shutil.rmtree(PREVIEW_CACHE_DIR)
        self.assertIsNone(get_most_recent_preview_frame("test_camera"))
