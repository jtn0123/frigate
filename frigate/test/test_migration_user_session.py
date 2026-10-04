"""Migration 900 (fork E26), run and rolled back through peewee_migrate's
Router the way Frigate's startup runs migrations."""

import os
import unittest

from peewee import SqliteDatabase
from peewee_migrate import Router

from frigate.fork.sessions import UserSession

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "migrations"
)
NAME = "900_fork_create_user_session"
INDEXES = {"usersession_username", "usersession_expires_at"}


class TestUserSessionMigration(unittest.TestCase):
    def setUp(self):
        self.db = SqliteDatabase(":memory:")
        self.router = Router(self.db, migrate_dir=MIGRATIONS_DIR)

    def tearDown(self):
        self.db.close()

    def test_runs_after_every_upstream_migration(self):
        todo = self.router.todo
        upstream = [name for name in todo if int(name.split("_", 1)[0]) < 900]
        # fork migrations (900 and up) follow every upstream one, this first
        self.assertEqual(todo.index(NAME), len(upstream))

    def test_migrate_creates_table_and_rollback_drops_it(self):
        self.router.run_one(NAME, self.router.migrator, fake=False)
        self.assertIn("usersession", self.db.get_tables())
        self.assertLessEqual(
            INDEXES, {index.name for index in self.db.get_indexes("usersession")}
        )
        self.assertIn(NAME, self.router.done)

        self.router.run_one(NAME, self.router.migrator, fake=False, downgrade=True)
        self.assertNotIn("usersession", self.db.get_tables())
        self.assertNotIn(NAME, self.router.done)

    def test_fresh_schema_matches_the_migration(self):
        self.router.run_one(NAME, self.router.migrator, fake=False)
        migrated = {
            (column.name, column.data_type, column.null)
            for column in self.db.get_columns("usersession")
        }
        migrated_indexes = {index.name for index in self.db.get_indexes("usersession")}

        fresh_db = SqliteDatabase(":memory:")
        self.addCleanup(fresh_db.close)
        with fresh_db.bind_ctx([UserSession]):
            fresh_db.create_tables([UserSession])
        fresh = {
            (column.name, column.data_type, column.null)
            for column in fresh_db.get_columns("usersession")
        }
        fresh_indexes = {index.name for index in fresh_db.get_indexes("usersession")}

        self.assertEqual(migrated, fresh)
        self.assertEqual(migrated_indexes, fresh_indexes)

    def test_fake_run_leaves_the_database_alone(self):
        self.router.run_one(NAME, self.router.migrator, fake=True)
        self.assertNotIn("usersession", self.db.get_tables())


if __name__ == "__main__":
    unittest.main()
