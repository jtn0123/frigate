"""Behavior tests for snapshot helpers and FileLock in frigate.util.file."""

import base64
import datetime
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import cv2
import numpy as np

from frigate.util import file as file_util
from frigate.util.file import FileLock


def _event(**overrides) -> SimpleNamespace:
    values = {
        "id": "evt1",
        "camera": "front",
        "label": "person",
        "thumbnail": None,
        "top_score": None,
        "score": None,
        "start_time": 100.0,
        "data": {},
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class TempDirsMixin(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.clips = os.path.join(tmp.name, "clips")
        self.thumbs = os.path.join(tmp.name, "thumbs")
        os.makedirs(self.clips)
        os.makedirs(os.path.join(self.thumbs, "front"))
        for name, value in (("CLIPS_DIR", self.clips), ("THUMB_DIR", self.thumbs)):
            patcher = patch.object(file_util, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _clip(self, suffix: str) -> str:
        return os.path.join(self.clips, f"front-evt1{suffix}")

    def _write_image(self, suffix: str, shape=(60, 80, 3)) -> str:
        path = self._clip(suffix)
        self.assertTrue(cv2.imwrite(path, np.full(shape, 50, np.uint8)))
        return path


class TestThumbnailBytes(TempDirsMixin):
    def test_inline_thumbnail_is_decoded(self) -> None:
        event = _event(thumbnail=base64.b64encode(b"img").decode())
        self.assertEqual(file_util.get_event_thumbnail_bytes(event), b"img")

    def test_file_thumbnail_is_read_and_missing_is_none(self) -> None:
        event = _event()
        self.assertIsNone(file_util.get_event_thumbnail_bytes(event))
        with open(os.path.join(self.thumbs, "front", "evt1.webp"), "wb") as f:
            f.write(b"webp")
        self.assertEqual(file_util.get_event_thumbnail_bytes(event), b"webp")


class TestSnapshotPath(TempDirsMixin):
    def test_no_snapshot(self) -> None:
        self.assertEqual(file_util.get_event_snapshot_path(_event()), (None, False))
        self.assertEqual(file_util.load_event_snapshot_image(_event()), (None, False))
        self.assertIsNone(file_util.get_event_snapshot(_event()))

    def test_legacy_jpg_is_not_clean(self) -> None:
        path = self._write_image(".jpg")
        self.assertEqual(file_util.get_event_snapshot_path(_event()), (path, False))
        self.assertEqual(
            file_util.get_event_snapshot_path(_event(), clean_only=True),
            (None, False),
        )
        image = file_util.get_event_snapshot(_event())
        self.assertEqual(image.shape, (60, 80, 3))

    def test_clean_png_is_preferred_over_jpg(self) -> None:
        self._write_image(".jpg")
        png = self._write_image("-clean.png")
        self.assertEqual(file_util.get_event_snapshot_path(_event()), (png, True))

    def test_unreadable_snapshot_logs_warning(self) -> None:
        with open(self._clip(".jpg"), "wb") as f:
            f.write(b"not an image")
        with self.assertLogs("frigate.util.file", level="WARNING"):
            self.assertEqual(
                file_util.load_event_snapshot_image(_event()), (None, False)
            )


class TestSnapshotBytes(TempDirsMixin):
    def test_missing_snapshot_returns_none(self) -> None:
        self.assertEqual(
            file_util.get_event_snapshot_bytes(_event(), ext="jpg"), (None, 0)
        )

    def test_legacy_snapshot_disables_overlays_and_passes_metadata(self) -> None:
        self._write_image(".jpg", shape=(100, 200, 3))
        event = _event(
            data={
                "box": [0.1, 0.2, 0.5, 0.5],
                "snapshot_frame_time": 123.5,
                "score": 0.77,
                "snapshot_area": 4000.0,
                "snapshot_estimated_speed": "12.5",
                "attributes": [
                    {"box": [0.0, 0.0, 0.1, 0.1], "label": "face", "score": 0.6},
                    {"box": None},
                    {"box": [0.5, 0.5, 0.1, 0.1]},
                ],
                "draw": {
                    "boxes": [
                        {"box": [0.1, 0.1, 0.2, 0.2], "color": [0, 255, 0]},
                        {"box": [0.3, 0.3, 0.2, 0.2], "color": "red", "score": 0.4},
                        {"box": [1]},
                    ]
                },
            }
        )

        with (
            patch.object(
                file_util, "get_snapshot_bytes", return_value=(b"jpg", 1.0)
            ) as render,
            self.assertLogs("frigate.util.file", level="WARNING"),
        ):
            result = file_util.get_event_snapshot_bytes(
                event,
                ext="jpg",
                timestamp=True,
                bounding_box=True,
                crop=True,
                colormap={"person": (1, 2, 3)},
            )

        self.assertEqual(result, (b"jpg", 1.0))
        args, kwargs = render.call_args
        self.assertEqual(args[1], 123.5)
        self.assertFalse(kwargs["timestamp"])
        self.assertFalse(kwargs["bounding_box"])
        self.assertFalse(kwargs["crop"])
        self.assertEqual(kwargs["box"], (20, 20, 120, 70))
        self.assertEqual(kwargs["score"], 0.77)
        self.assertEqual(kwargs["area"], 4000)
        self.assertEqual(kwargs["estimated_speed"], 12.5)
        self.assertEqual(kwargs["color"], (1, 2, 3))
        self.assertEqual(
            kwargs["attributes"],
            [
                {"box": (0, 0, 20, 10), "label": "face", "score": 0.6},
                {"box": (100, 50, 120, 60), "label": "attribute", "score": 0},
            ],
        )
        self.assertEqual(
            kwargs["overlay_boxes"],
            [
                {
                    "box": (20, 10, 60, 30),
                    "label": "person",
                    "score": None,
                    "color": (0, 255, 0),
                },
                {
                    "box": (60, 30, 100, 50),
                    "label": "person",
                    "score": 0.4,
                    "color": (255, 0, 0),
                },
            ],
        )

    def test_clean_snapshot_keeps_requested_overlays(self) -> None:
        self._write_image("-clean.png")
        event = _event(data=None, top_score=0.5)
        with patch.object(
            file_util, "get_snapshot_bytes", return_value=(b"x", 2.0)
        ) as render:
            file_util.get_event_snapshot_bytes(
                event, ext="png", timestamp=True, bounding_box=True
            )

        args, kwargs = render.call_args
        self.assertEqual(args[1], 100.0)
        self.assertTrue(kwargs["timestamp"])
        self.assertTrue(kwargs["bounding_box"])
        self.assertIsNone(kwargs["box"])
        self.assertEqual(kwargs["score"], 0.5)
        self.assertIsNone(kwargs["area"])
        self.assertEqual(kwargs["estimated_speed"], 0)
        self.assertEqual(kwargs["attributes"], [])
        self.assertEqual(kwargs["overlay_boxes"], [])
        self.assertEqual(kwargs["color"], (255, 255, 255))


class TestSnapshotMetadataFallbacks(unittest.TestCase):
    def test_frame_time_fallbacks(self) -> None:
        moment = datetime.datetime(2024, 1, 1, tzinfo=datetime.UTC)
        frame_time = file_util._get_event_snapshot_frame_time
        self.assertEqual(frame_time(_event(data={"frame_time": "5"})), 5.0)
        self.assertEqual(frame_time(_event(data={"x": 1})), 100.0)
        self.assertEqual(
            frame_time(_event(data={}, start_time=moment)), moment.timestamp()
        )

    def test_score_fallbacks(self) -> None:
        score = file_util._get_event_snapshot_score
        self.assertEqual(score(_event(data={"top_score": 0.4})), 0.4)
        self.assertEqual(score(_event(data={"x": 1}, score=0.3)), 0.3)
        self.assertEqual(score(_event()), 0)

    def test_speed_and_area_fallbacks(self) -> None:
        speed = file_util._get_event_snapshot_estimated_speed
        self.assertEqual(speed(_event(data={"average_estimated_speed": 3})), 3.0)
        self.assertEqual(speed(_event(data={"x": 1})), 0)
        self.assertIsNone(file_util._get_event_snapshot_area(_event(data={"x": 1})))

    def test_overlay_boxes_ignore_non_dict_draw_data(self) -> None:
        event = _event(data={"draw": ["not", "a", "dict"]})
        self.assertEqual(
            file_util._get_event_snapshot_overlay_boxes((10, 10, 3), event), []
        )


class TestDeleteSnapshots(TempDirsMixin):
    def test_deletes_every_snapshot_variant_and_thumbnail(self) -> None:
        paths = [self._write_image(s) for s in (".jpg", "-clean.webp", "-clean.png")]
        thumb = Path(self.thumbs, "front", "evt1.webp")
        thumb.write_bytes(b"t")

        self.assertTrue(file_util.delete_event_images(_event()))

        for path in paths:
            self.assertFalse(os.path.exists(path))
        self.assertFalse(thumb.exists())

    def test_snapshot_delete_error_returns_false(self) -> None:
        with patch.object(Path, "unlink", side_effect=PermissionError("denied")):
            self.assertFalse(file_util.delete_event_snapshot(_event()))
            self.assertFalse(file_util.delete_event_images(_event()))


class TestFileLock(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name, "nested", "resource.lock")

    def _age(self, seconds: float) -> None:
        old = time.time() - seconds
        os.utime(self.path, (old, old))

    def test_context_manager_acquires_and_removes_lock(self) -> None:
        with FileLock(self.path, timeout=1) as lock:
            self.assertTrue(lock._acquired)
            self.assertTrue(self.path.exists())
            # acquiring twice is a no-op that still reports success
            with self.assertLogs("frigate.util.file", level="WARNING"):
                self.assertTrue(lock.acquire())
        self.assertFalse(self.path.exists())
        self.assertFalse(lock._acquired)

    def test_second_holder_times_out(self) -> None:
        first = FileLock(self.path, timeout=1)
        self.assertTrue(first.acquire())
        second = FileLock(self.path, poll_interval=0.01)
        self.assertFalse(second.acquire(timeout=0.05))
        self.assertIsNone(second._fd)
        with self.assertRaises(TimeoutError):
            FileLock(self.path, timeout=0).__enter__()
        # a zero poll interval reaches the timeout inside the retry handler
        third = FileLock(self.path, poll_interval=0)
        with (
            patch.object(
                file_util,
                "time",
                SimpleNamespace(time=Mock(side_effect=[0, 0, 0, 5]), sleep=Mock()),
            ),
            self.assertLogs("frigate.util.file", level="WARNING"),
        ):
            self.assertFalse(third.acquire(timeout=1))
        self.assertIsNone(third._fd)
        first.release()
        self.assertTrue(second.acquire(timeout=1))
        second.release()

    def test_stale_detection_and_cleanup(self) -> None:
        lock = FileLock(self.path, stale_timeout=10)
        self.assertFalse(lock.is_stale())

        self.path.parent.mkdir(parents=True)
        self.path.touch()
        self.assertFalse(lock.is_stale())
        self._age(60)
        self.assertTrue(lock.is_stale())

        with self.assertLogs("frigate.util.file", level="WARNING"):
            FileLock(self.path, stale_timeout=10, cleanup_stale_on_init=True)
        self.assertFalse(self.path.exists())

    def test_stat_errors_are_tolerated(self) -> None:
        lock = FileLock(self.path)
        with patch.object(Path, "exists", side_effect=OSError("io")):
            self.assertFalse(lock.is_stale())
            with self.assertLogs("frigate.util.file", level="ERROR"):
                self.assertFalse(lock._cleanup_stale_lock())

    def test_open_failure_returns_false(self) -> None:
        lock = FileLock(self.path)
        with (
            patch.object(file_util.os, "open", side_effect=OSError("denied")),
            self.assertLogs("frigate.util.file", level="ERROR"),
        ):
            self.assertFalse(lock.acquire(timeout=1))
        self.assertIsNone(lock._fd)

    def test_flock_error_after_open_closes_descriptor(self) -> None:
        lock = FileLock(self.path)
        with (
            patch.object(file_util.fcntl, "flock", side_effect=RuntimeError("x")),
            self.assertLogs("frigate.util.file", level="ERROR"),
        ):
            self.assertFalse(lock.acquire(timeout=1))
        self.assertIsNone(lock._fd)

    def test_release_without_acquire_is_noop(self) -> None:
        lock = FileLock(self.path)
        lock.release()
        self.assertFalse(lock._acquired)

    def test_release_tolerates_unlock_and_unlink_errors(self) -> None:
        lock = FileLock(self.path, timeout=1)
        self.assertTrue(lock.acquire())
        with (
            patch.object(file_util.fcntl, "flock", side_effect=OSError("x")),
            self.assertLogs("frigate.util.file", level="WARNING"),
        ):
            lock.release()
        self.assertFalse(lock._acquired)
        self.assertIsNone(lock._fd)
        self.assertFalse(self.path.exists())

        self.assertTrue(lock.acquire())
        with patch.object(Path, "unlink", side_effect=FileNotFoundError()):
            lock.release()
        self.assertFalse(lock._acquired)

        self.assertTrue(lock.acquire())
        with (
            patch.object(Path, "unlink", side_effect=PermissionError("denied")),
            self.assertLogs("frigate.util.file", level="ERROR"),
        ):
            lock.release()
        self.assertFalse(lock._acquired)

    def test_destructor_releases_held_lock(self) -> None:
        lock = FileLock(self.path, timeout=1)
        self.assertTrue(lock.acquire())
        lock.__del__()
        self.assertFalse(self.path.exists())
        self.assertFalse(lock._acquired)


if __name__ == "__main__":
    unittest.main()
