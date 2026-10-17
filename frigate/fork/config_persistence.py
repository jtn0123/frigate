"""Locked, durable replacement of the persisted configuration."""

import os
import stat
import tempfile
from pathlib import Path

from filelock import FileLock


def config_file_lock(path: str) -> FileLock:
    """Use the same lock for a configuration file and its symlink aliases."""
    return FileLock(f"{Path(path).resolve()}.lock", timeout=5)


def write_config_file(path: str, content: str) -> None:
    """Atomically save validated YAML while the caller holds its file lock.

    The configuration directory must be writable and mounted as a directory.
    Single-file bind mounts cannot support atomic replacement, so a rejected
    replacement leaves the previous configuration intact.
    """
    destination = Path(path).resolve()
    previous = destination.stat() if destination.exists() else None
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=destination.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            if previous is not None:
                current = os.fstat(temporary.fileno())
                if (current.st_uid, current.st_gid) != (
                    previous.st_uid,
                    previous.st_gid,
                ):
                    os.fchown(temporary.fileno(), previous.st_uid, previous.st_gid)
                os.fchmod(temporary.fileno(), stat.S_IMODE(previous.st_mode))
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
        descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
