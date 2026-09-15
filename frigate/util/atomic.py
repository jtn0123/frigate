"""Atomic writes for private runtime files."""

import os
import tempfile
from pathlib import Path


def write_private_file(path: Path, content: str) -> None:
    """Durably replace a file with owner-only content, without following symlinks."""
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def ensure_private_directory(path: Path) -> None:
    """Secure an owned runtime directory without following a final symlink."""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        owner = os.fstat(descriptor).st_uid
        if owner != os.geteuid():
            raise PermissionError(
                f"Runtime directory {path} is owned by UID {owner}, "
                f"not by UID {os.geteuid()} that this process runs as"
            )
        os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)
