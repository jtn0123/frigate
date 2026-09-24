"""E23: cached preview frames are matched to their camera by the full name."""

import datetime
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from peewee import SqliteDatabase

import frigate.api.preview as preview_api
from frigate.const import PREVIEW_FRAME_TYPE
from frigate.models import Previews
from frigate.output.preview import is_camera_preview_frame
from frigate.test.test_export_progress import _make_exporter


class TestIsCameraPreviewFrame(unittest.TestCase):
    def test_matches_own_frames_only(self):
        self.assertTrue(is_camera_preview_frame("preview_front-1.5.webp", "front"))
        self.assertTrue(
            is_camera_preview_frame("preview_front-door-1.5.webp", "front-door")
        )
        self.assertFalse(
            is_camera_preview_frame("preview_front-door-1.5.webp", "front")
        )
        self.assertFalse(is_camera_preview_frame("preview_front2-1.5.webp", "front"))


class _PreviewDirTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp_root = tempfile.mkdtemp(prefix="frigate_preview_match_")
        self.cache_dir = os.path.join(self.tmp_root, "cache")
        self.preview_dir = os.path.join(self.cache_dir, "preview_frames")
        os.makedirs(self.preview_dir)
        self.addCleanup(shutil.rmtree, self.tmp_root, True)

    def frame(self, camera: str, ts: float) -> str:
        name = f"preview_{camera}-{ts}.{PREVIEW_FRAME_TYPE}"
        with open(os.path.join(self.preview_dir, name), "wb") as f:
            f.write(camera.encode())
        return name


class TestPreviewFramesEndpoint(_PreviewDirTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch.object(preview_api, "CACHE_DIR", self.cache_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(preview_api, "_preview_listing_cache", (-1.0, []))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_other_camera_frames_inside_the_range_are_left_out(self):
        own = self.frame("front", 1200.0)
        # "preview_front-1500-1600.0" sorts between the range bounds of
        # "front", so the bisected slice alone does not exclude it
        self.frame("front-1500", 1600.0)

        resp = preview_api.get_preview_frames_from_cache("front", 1000.0, 2000.0)

        self.assertEqual(json.loads(resp.body), [own])


class TestExportPreviewFrameSelection(_PreviewDirTestCase):
    def setUp(self):
        super().setUp()
        for target in ("CACHE_DIR", "CLIPS_DIR"):
            patcher = patch(
                f"frigate.record.export.{target}",
                self.cache_dir if target == "CACHE_DIR" else self.tmp_root,
            )
            patcher.start()
            self.addCleanup(patcher.stop)
        os.makedirs(os.path.join(self.tmp_root, "export"))

        now = datetime.datetime.now(datetime.UTC).timestamp()
        self.exporter = _make_exporter()
        self.exporter.export_id = "match"
        self.exporter.start_time = now
        self.exporter.end_time = now + 3

    def test_thumbnail_fallback_ignores_other_camera(self):
        own = self.frame("front", self.exporter.start_time - 10.0)
        # this camera's frames sort after the prior frame of "front" and
        # before its window, so a prefix match took one as the fallback
        start = self.exporter.start_time
        self.frame(f"front-{int(start) - 5}", start - 5.0)

        result = self.exporter.save_thumbnail(self.exporter.export_id)

        self.assertTrue(result)
        with (
            open(result, "rb") as f,
            open(os.path.join(self.preview_dir, own), "rb") as src,
        ):
            self.assertEqual(f.read(), src.read())

    def test_preview_export_playlist_ignores_other_camera(self):
        start = self.exporter.start_time
        own = self.frame("front", start + 1.0)
        other_camera = f"front-{int(start) + 1}"
        self.frame(other_camera, start + 2.0)
        self.exporter.get_datetime_from_timestamp = lambda ts: str(ts)

        db = SqliteDatabase(":memory:")
        with db.bind_ctx([Previews]):
            db.create_tables([Previews])
            _, playlist = self.exporter.get_preview_export_command("/tmp/out.mp4")

        files = [line for line in playlist if line.startswith("file ")]
        self.assertEqual(
            files,
            [f"file '{os.path.join(self.preview_dir, own)}'"] * 2,
        )


if __name__ == "__main__":
    unittest.main()
