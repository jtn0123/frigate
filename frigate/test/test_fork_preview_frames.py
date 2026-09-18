"""Tests for the cached preview frame selection used by the preview GIF and MP4."""

import os
import shutil
import tempfile
import unittest

from frigate.api.fork_preview_frames import select_preview_frames
from frigate.const import PREVIEW_FRAME_TYPE


class TestSelectPreviewFrames(unittest.TestCase):
    def setUp(self):
        self.preview_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.preview_dir, ignore_errors=True)

    def _frame(self, camera: str, timestamp: float) -> str:
        name = f"preview_{camera}-{timestamp}.{PREVIEW_FRAME_TYPE}"

        with open(os.path.join(self.preview_dir, name), "wb") as f:
            f.write(b"frame")

        return name

    def test_selects_only_the_cameras_frames_in_range_oldest_first(self):
        # written out of order, since a directory scan has no order
        late = self._frame("front_door", 1700000030.5)
        early = self._frame("front_door", 1700000010.25)
        middle = self._frame("front_door", 1700000020.0)
        self._frame("front_door", 1700000009.9)
        self._frame("front_door", 1700000040.1)
        self._frame("back_door", 1700000020.0)
        self._frame("back_door", 1700000025.0)

        frames = select_preview_frames(
            self.preview_dir, "front_door", 1700000010.0, 1700000040.0
        )

        assert frames == [early, middle, late]

    def test_range_bounds_are_inclusive(self):
        first = self._frame("front_door", 1700000010.0)
        last = self._frame("front_door", 1700000040.0)

        frames = select_preview_frames(
            self.preview_dir, "front_door", 1700000010.0, 1700000040.0
        )

        assert frames == [first, last]

    def test_camera_name_that_prefixes_another_camera(self):
        own = self._frame("cam", 1700000020.0)
        other = self._frame("cam-1", 1700000020.0)
        self._frame("cam_2", 1700000020.0)

        assert select_preview_frames(
            self.preview_dir, "cam", 1700000010.0, 1700000040.0
        ) == [own]
        assert select_preview_frames(
            self.preview_dir, "cam-1", 1700000010.0, 1700000040.0
        ) == [other]

    def test_no_frames_for_the_camera(self):
        self._frame("back_door", 1700000020.0)

        assert (
            select_preview_frames(
                self.preview_dir, "front_door", 1700000010.0, 1700000040.0
            )
            == []
        )

    def test_missing_directory_selects_nothing(self):
        missing = os.path.join(self.preview_dir, "missing")

        assert select_preview_frames(missing, "front_door", 0.0, 1.0) == []

    def test_path_that_is_not_a_directory_selects_nothing(self):
        not_a_directory = os.path.join(self.preview_dir, "file")

        with open(not_a_directory, "w") as f:
            f.write("x")

        assert select_preview_frames(not_a_directory, "front_door", 0.0, 1.0) == []


if __name__ == "__main__":
    unittest.main()
