"""Retain a bounded set of unverified new recordings for diagnosis."""

import os
import re
import stat
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

QUARANTINE_DIRECTORY = ".integrity"
MAX_QUARANTINE_BYTES = 256 * 1024 * 1024
MAX_QUARANTINE_FILES = 128
QUARANTINE_SECONDS = 24 * 3600
PRUNE_INTERVAL = 60
MAX_SCAN_ENTRIES = 512


def walk_recording_tree(directory: str) -> Iterator[tuple[str, list[str], list[str]]]:
    """Keep the exact evidence store under its independent bounded retention."""
    for root, directories, files in os.walk(directory):
        if root == directory and QUARANTINE_DIRECTORY in directories:
            directories.remove(QUARANTINE_DIRECTORY)
        yield root, directories, files


class RecordingQuarantine:
    """Preserve recent unverified outputs without creating unmanaged orphans."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._lock = threading.Lock()
        self._last_prune = 0.0

    def _entries(self) -> list[tuple[float, int, Path]]:
        entries: list[tuple[float, int, Path]] = []
        if not self.directory.exists():
            return entries
        with os.scandir(self.directory) as children:
            for count, child in enumerate(children, 1):
                if count > MAX_SCAN_ENTRIES:
                    raise OSError("Recording quarantine scan limit exceeded")
                if not child.name.startswith("integrity-") or not child.name.endswith(
                    ".mp4"
                ):
                    continue
                value = child.stat(follow_symlinks=False)
                if stat.S_ISREG(value.st_mode):
                    entries.append((value.st_mtime, value.st_size, Path(child.path)))
        return sorted(entries)

    def _prune(self, now: float, incoming_bytes: int | None = None) -> None:
        entries = self._entries()
        total = sum(size for _, size, _ in entries)
        remaining = len(entries)
        allowance = MAX_QUARANTINE_FILES - (incoming_bytes is not None)
        for modified, size, path in entries:
            expired = now - modified >= QUARANTINE_SECONDS
            oversized = total + (incoming_bytes or 0) > MAX_QUARANTINE_BYTES
            if expired or remaining > allowance or oversized:
                path.unlink(missing_ok=True)
                total -= size
                remaining -= 1
        self._last_prune = now

    def prune(self, now: float | None = None) -> None:
        """Expire evidence even when no new integrity failures occur."""
        now = time.time() if now is None else now
        with self._lock:
            if now - self._last_prune >= PRUNE_INTERVAL:
                self._prune(now)

    def preserve(
        self,
        source: Path,
        camera: str,
        stream_type: str,
        reason: str,
        now: float | None = None,
    ) -> Path:
        """Move a completed output into bounded evidence storage atomically."""
        now = time.time() if now is None else now
        with self._lock:
            value = source.lstat()
            if not stat.S_ISREG(value.st_mode) or value.st_size > MAX_QUARANTINE_BYTES:
                raise OSError("Recording exceeds quarantine file limit")
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            self._prune(now, value.st_size)
            camera = re.sub(r"[^A-Za-z0-9_-]", "_", camera)[:64]
            stream_type = "sub" if stream_type == "sub" else "main"
            reason = re.sub(r"[^a-z_]", "", reason)[:32]
            name = f"integrity-{camera}-{stream_type}-{reason}-{uuid.uuid4().hex}.mp4"
            destination = self.directory / name
            os.replace(source, destination)
            os.utime(destination, (now, now))
            return destination
