"""Track which cached recording segments are still open by ffmpeg."""

import logging
import os

import psutil

from frigate.const import CACHE_DIR

logger = logging.getLogger(__name__)


def camera_from_cache_file(file_name: str) -> str | None:
    """Return the camera name encoded in a cache segment file name."""
    basename = os.path.splitext(file_name)[0]

    if "@" not in basename:
        return None

    return basename.rsplit("@", maxsplit=1)[0]


class CacheFileTracker:
    """Answer "which cache segments are being written right now" cheaply.

    The authoritative signal is the set of files each ffmpeg process has
    open, so that is still what is consulted. The expensive part is finding
    the ffmpeg processes: walking the whole process table and calling
    name() on every entry each cycle. That walk now happens only when a
    tracked writer has exited or a camera has cache files but no known
    writer (startup, camera added, ffmpeg restarted). Every other cycle
    asks only the tracked processes for their open files, so the cost
    scales with the number of recording cameras rather than with the number
    of processes on the host.
    """

    def __init__(self, cache_dir: str = CACHE_DIR) -> None:
        self.cache_dir = cache_dir
        self._writers: dict[int, psutil.Process] = {}

    def files_in_use(self, cache_files: list[str]) -> set[str]:
        """Return the cache file names currently open by an ffmpeg process."""
        in_use, cameras_seen = self._open_cache_files()

        cameras_with_cache = {
            camera
            for camera in (camera_from_cache_file(f) for f in cache_files)
            if camera is not None
        }

        if cameras_with_cache - cameras_seen:
            self._discover_writers()
            in_use, _ = self._open_cache_files()

        return in_use

    def _discover_writers(self) -> None:
        """Walk the process table for ffmpeg processes holding cache files."""
        writers: dict[int, psutil.Process] = {}

        for process in psutil.process_iter():
            try:
                if process.name() != "ffmpeg":
                    continue

                if any(f.path.startswith(self.cache_dir) for f in process.open_files()):
                    writers[process.pid] = process
            except psutil.Error:
                continue

        logger.debug("Tracking %d ffmpeg cache writers", len(writers))
        self._writers = writers

    def _open_cache_files(self) -> tuple[set[str], set[str]]:
        """Return (file names, camera names) open by the tracked processes."""
        in_use: set[str] = set()
        cameras: set[str] = set()
        exited: list[int] = []

        for pid, process in self._writers.items():
            try:
                if not process.is_running():
                    raise psutil.NoSuchProcess(pid)

                open_files = process.open_files()
            except psutil.Error:
                # exited (or the pid was reused): forget it so the next
                # cycle rediscovers the replacement
                exited.append(pid)
                continue

            for f in open_files:
                if not f.path.startswith(self.cache_dir):
                    continue

                name = f.path.split("/")[-1]
                in_use.add(name)

                camera = camera_from_cache_file(name)
                if camera is not None:
                    cameras.add(camera)

        for pid in exited:
            del self._writers[pid]

        return in_use, cameras
