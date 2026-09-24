"""Migration 039 (G18): the composite (camera, start_time) index on events.

peewee_migrate compiles migrations under the name "<string>", so the module is
loaded straight from its file here and run with a real Migrator."""

import importlib.util
import os
import unittest

from peewee import SqliteDatabase
from peewee_migrate import Migrator

MIGRATION_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "..",
    "migrations",
    "039_add_perf_indexes.py",
)
INDEX = "event_camera_start_time"


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_039", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestPerfIndexesMigration(unittest.TestCase):
    def setUp(self):
        self.migration = _load_migration()
        self.db = SqliteDatabase(":memory:")
        self.db.execute_sql(
            'CREATE TABLE "event" ("id" VARCHAR(30) PRIMARY KEY, '
            '"camera" VARCHAR(20), "start_time" DATETIME)'
        )

    def tearDown(self):
        self.db.close()

    def _run(self, fn):
        migrator = Migrator(self.db)
        fn(migrator, self.db)
        migrator()

    def _event_index(self):
        return next((i for i in self.db.get_indexes("event") if i.name == INDEX), None)

    def test_migrate_adds_camera_start_time_index(self):
        self._run(self.migration.migrate)

        index = self._event_index()
        self.assertIsNotNone(index)
        self.assertEqual(index.columns, ["camera", "start_time"])
        self.assertFalse(index.unique)

    def test_migrate_is_idempotent(self):
        self._run(self.migration.migrate)
        # a second run must not fail on the existing index
        self._run(self.migration.migrate)
        self.assertIsNotNone(self._event_index())

    def test_rollback_drops_the_index(self):
        self._run(self.migration.migrate)
        self._run(self.migration.rollback)
        self.assertIsNone(self._event_index())

        # rolling back again is a no-op rather than an error
        self._run(self.migration.rollback)
        self.assertIsNone(self._event_index())

    def test_single_camera_query_uses_the_index(self):
        self._run(self.migration.migrate)
        plan = self.db.execute_sql(
            "EXPLAIN QUERY PLAN SELECT id FROM event "
            "WHERE camera = ? ORDER BY start_time DESC",
            ("front",),
        ).fetchall()
        self.assertTrue(any(INDEX in str(row) for row in plan), plan)


if __name__ == "__main__":
    unittest.main()
