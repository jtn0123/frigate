"""Migration backup regressions using real SQLite databases and WAL files."""

import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate.app import FrigateApp
from frigate.fork.database_backup import backup_database


class MigrationReached(Exception):
    """Stop startup immediately after reaching the migration runner."""


class TestMigrationBackup(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def migrate(self, path, pending=True):
        app = SimpleNamespace(
            config=SimpleNamespace(database=SimpleNamespace(path=str(path)))
        )
        router = Mock(diff=["pending"] if pending else [])
        router.run.side_effect = MigrationReached
        with patch("frigate.app.Router", return_value=router):
            with self.assertRaises(MigrationReached):
                FrigateApp.init_database(app)
        return router

    def test_custom_filename_reaches_migrations_with_recoverable_backup(self):
        path = self.directory / "events.sqlite"
        with sqlite3.connect(path) as source:
            source.execute("create table evidence (value text)")
            source.execute("insert into evidence values ('committed')")
        self.migrate(path)
        with sqlite3.connect(self.directory / "events.backup.sqlite") as backup:
            self.assertEqual(
                backup.execute("select value from evidence").fetchall(),
                [("committed",)],
            )
        self.assertTrue(path.exists())

    def test_backup_includes_committed_rows_still_in_wal(self):
        path = self.directory / "frigate.db"
        source = sqlite3.connect(path)
        self.addCleanup(source.close)
        source.execute("pragma journal_mode=wal")
        source.execute("pragma wal_autocheckpoint=0")
        source.execute("create table evidence (value text)")
        source.commit()
        source.execute("pragma wal_checkpoint(truncate)")
        source.execute("insert into evidence values ('in the wal')")
        source.commit()
        self.assertGreater(Path(f"{path}-wal").stat().st_size, 0)
        self.migrate(path)
        with sqlite3.connect(self.directory / "backup.db") as backup:
            self.assertEqual(
                backup.execute("select value from evidence").fetchall(),
                [("in the wal",)],
            )
            self.assertEqual(backup.execute("pragma quick_check").fetchone(), ("ok",))

    def test_no_pending_migrations_do_not_create_a_backup(self):
        path = self.directory / "frigate.db"
        sqlite3.connect(path).close()
        self.migrate(path, pending=False)
        self.assertFalse((self.directory / "backup.db").exists())

    def test_failed_backup_prevents_migration_and_preserves_existing_backup(self):
        path = self.directory / "frigate.db"
        backup = self.directory / "backup.db"
        backup.write_bytes(b"previous backup")
        sqlite3.connect(path).close()
        app = SimpleNamespace(
            config=SimpleNamespace(database=SimpleNamespace(path=str(path)))
        )
        router = Mock(diff=["pending"])
        with (
            patch("frigate.app.Router", return_value=router),
            patch(
                "frigate.fork.database_backup.os.replace",
                side_effect=PermissionError("read only"),
            ),
            self.assertRaises(PermissionError),
        ):
            FrigateApp.init_database(app)
        router.run.assert_not_called()
        self.assertEqual(backup.read_bytes(), b"previous backup")
        self.assertEqual(
            sorted(p.name for p in self.directory.iterdir()),
            ["backup.db", "frigate.db"],
        )

    def test_source_named_backup_db_is_never_overwritten(self):
        path = self.directory / "backup.db"
        with sqlite3.connect(path) as source:
            source.execute("create table evidence (value text)")
            source.commit()
            destination = backup_database(source, str(path))
        self.assertEqual(destination.name, "backup.backup.db")
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
