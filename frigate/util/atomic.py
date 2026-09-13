"""Atomic writes for private runtime files."""

import os
import tempfile
from pathlib import Path


def write_private_file(path: Path, content: str) -> None:
    """Replace a file atomically with owner-only content, without following symlinks."""
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
