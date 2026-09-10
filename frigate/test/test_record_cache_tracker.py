"""Tests for the ffmpeg cache segment tracker used by the recording maintainer."""

import unittest
from collections import namedtuple
from unittest.mock import MagicMock, patch

import psutil

from frigate.record.cache_tracker import CacheFileTracker, camera_from_cache_file

OpenFile = namedtuple("OpenFile", ["path", "fd"])
CACHE = "/tmp/cache"


def fake_process(pid: int, name: str, files: list[str]) -> MagicMock:
    process = MagicMock()
    process.pid = pid
    process.name.return_value = name
    process.is_running.return_value = True
    process.open_files.return_value = [OpenFile(f, 3) for f in files]
    return process


class TestCameraFromCacheFile(unittest.TestCase):
    def test_parses_camera_and_ignores_unexpected_names(self):
        assert camera_from_cache_file("front@20260101000000+0000.mp4") == "front"
        assert camera_from_cache_file("front-door@20260101000000+0000.mp4") == (
            "front-door"
        )
        assert camera_from_cache_file("stray.mp4") is None


class TestCacheFileTracker(unittest.TestCase):
    def setUp(self):
        self.tracker = CacheFileTracker(cache_dir=CACHE)
        self.front = fake_process(10, "ffmpeg", [f"{CACHE}/front@1.mp4"])
        self.back = fake_process(11, "ffmpeg", [f"{CACHE}/back@1.mp4"])
        self.detect = fake_process(12, "ffmpeg", ["/dev/shm/frames"])
        self.other = fake_process(13, "python3", [f"{CACHE}/other@1.mp4"])
        self.processes = [self.front, self.back, self.detect, self.other]
        self.patcher = patch(
            "frigate.record.cache_tracker.psutil.process_iter",
            return_value=self.processes,
        )
        self.process_iter = self.patcher.start()

    def tearDown(self):
        self.patcher.stop()

    def test_only_ffmpeg_cache_files_are_in_use(self):
        in_use = self.tracker.files_in_use(
            ["front@1.mp4", "front@0.mp4", "back@1.mp4", "other@1.mp4"]
        )
        assert in_use == {"front@1.mp4", "back@1.mp4"}
        assert set(self.tracker._writers) == {10, 11}

    def test_process_table_is_not_walked_when_writers_are_known(self):
        self.tracker.files_in_use(["front@1.mp4", "back@1.mp4"])
        assert self.process_iter.call_count == 1

        # the writers move on to the next segment; still no full walk
        self.front.open_files.return_value = [OpenFile(f"{CACHE}/front@2.mp4", 3)]
        in_use = self.tracker.files_in_use(["front@1.mp4", "front@2.mp4", "back@1.mp4"])
        assert in_use == {"front@2.mp4", "back@1.mp4"}
        assert self.process_iter.call_count == 1

    def test_camera_without_known_writer_triggers_rediscovery(self):
        self.processes.remove(self.back)
        self.tracker.files_in_use(["front@1.mp4"])
        assert self.process_iter.call_count == 1

        # a new camera starts recording: its file must not be treated as done
        self.processes.append(self.back)
        in_use = self.tracker.files_in_use(["front@1.mp4", "back@1.mp4"])
        assert in_use == {"front@1.mp4", "back@1.mp4"}
        assert self.process_iter.call_count == 2

    def test_exited_writer_is_forgotten_and_replacement_found(self):
        self.tracker.files_in_use(["front@1.mp4", "back@1.mp4"])

        self.front.is_running.return_value = False
        replacement = fake_process(20, "ffmpeg", [f"{CACHE}/front@2.mp4"])
        self.processes.remove(self.front)
        self.processes.append(replacement)

        in_use = self.tracker.files_in_use(["front@1.mp4", "front@2.mp4", "back@1.mp4"])
        assert in_use == {"front@2.mp4", "back@1.mp4"}
        assert set(self.tracker._writers) == {11, 20}

    def test_psutil_errors_are_tolerated(self):
        self.detect.name.side_effect = psutil.AccessDenied(12)
        self.tracker.files_in_use(["front@1.mp4", "back@1.mp4"])

        self.back.open_files.side_effect = psutil.NoSuchProcess(11)
        in_use = self.tracker.files_in_use(["front@1.mp4"])
        assert in_use == {"front@1.mp4"}
        assert set(self.tracker._writers) == {10}

    def test_unexpected_cache_files_do_not_force_rediscovery(self):
        self.tracker.files_in_use(["front@1.mp4", "back@1.mp4"])
        self.tracker.files_in_use(["front@1.mp4", "back@1.mp4", "stray.mp4"])
        assert self.process_iter.call_count == 1
