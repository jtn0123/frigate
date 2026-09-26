"""Verify multi-stream migrations upgrade a database with fork migrations."""

import os
import unittest

from peewee import SqliteDatabase
from peewee_migrate import Router

MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "migrations")
STREAM_MIGRATIONS = {
    "036_add_recordings_stream_metadata",
    "037_add_recordings_stream_index",
}


class TestRecordingStreamMigrations(unittest.TestCase):
    def test_upgrade_preserves_legacy_recordings_and_fork_tables(self):
        database = SqliteDatabase(":memory:")
        self.addCleanup(database.close)
        router = Router(database, migrate_dir=MIGRATIONS_DIR)
        for name in router.todo:
            if name not in STREAM_MIGRATIONS:
                router.run_one(name, router.migrator, fake=False)
        database.execute_sql(
            "INSERT INTO recordings (id, camera, path, start_time, end_time, duration, segment_size) "
            "VALUES ('legacy', 'front', '/media/legacy.mp4', 1000, 1010, 10, 1)"
        )
        self.assertEqual(set(router.diff), STREAM_MIGRATIONS)
        router.run()
        row = database.execute_sql(
            "SELECT path, stream_type, has_audio, video_codec, keyframes "
            "FROM recordings WHERE id = 'legacy'"
        ).fetchone()
        self.assertEqual(row, ("/media/legacy.mp4", "main", None, None, None))
        self.assertIn("sharelink", database.get_tables())
        self.assertIn(
            "recordings_camera_stream_type_start_time",
            {index.name for index in database.get_indexes("recordings")},
        )
        self.assertEqual(router.diff, [])
        router.run()
        self.assertEqual(
            database.execute_sql("SELECT COUNT(*) FROM recordings").fetchone(), (1,)
        )
