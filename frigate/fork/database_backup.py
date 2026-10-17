"""Consistent SQLite snapshots before schema migrations."""

import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path


def backup_database(source: sqlite3.Connection, path: str) -> Path:
    """Publish a complete backup, including committed WAL data.

    Keep the historical backup.db name for the standard frigate.db path.
    Custom paths get a distinct sibling rather than overwriting the source.
    Failure leaves any previous backup intact and prevents migration startup.
    """
    database = Path(path).resolve()
    name = (
        "backup.db"
        if database.name == "frigate.db"
        else f"{database.stem}.backup{database.suffix}"
    )
    destination = database.with_name(name)
    descriptor, temporary_name = tempfile.mkstemp(dir=database.parent)
    temporary = Path(temporary_name)
    os.close(descriptor)
    try:
        # Peewee prefers pysqlite3 in the production image. Its backup API
        # requires a destination from the same SQLite adapter as the source.
        with closing(type(source)(str(temporary))) as snapshot:
            source.backup(snapshot)
        with temporary.open("rb") as snapshot_file:
            os.fsync(snapshot_file.fileno())
        os.replace(temporary, destination)
        descriptor = os.open(database.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return destination
    finally:
        temporary.unlink(missing_ok=True)
