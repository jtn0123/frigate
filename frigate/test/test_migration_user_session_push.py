"""Migration 901 (fork E27), run and rolled back through peewee_migrate's
Router the way Frigate's startup runs migrations."""

import os
import unittest

from peewee import SqliteDatabase
from peewee_migrate import Router

from frigate.fork.session_reach import UserSessionPush

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "migrations"
)
NAME = "901_fork_create_user_session_push"
SESSIONS = "900_fork_create_user_session"
INDEXES = {"usersessionpush_username", "usersessionpush_session_id"}


class TestUserSessionPushMigration(unittest.TestCase):
    def setUp(self):
        self.db = SqliteDatabase(":memory:")
        self.router = Router(self.db, migrate_dir=MIGRATIONS_DIR)

    def tearDown(self):
        self.db.close()

    def test_runs_after_the_sessions_table(self):
        todo = self.router.todo
        self.assertEqual(todo.index(NAME), todo.index(SESSIONS) + 1)

    def test_migrate_creates_table_and_rollback_drops_it(self):
        self.router.run_one(NAME, self.router.migrator, fake=False)
        self.assertIn("usersessionpush", self.db.get_tables())
        self.assertLessEqual(
            INDEXES, {index.name for index in self.db.get_indexes("usersessionpush")}
        )
        self.assertIn(NAME, self.router.done)

        self.router.run_one(NAME, self.router.migrator, fake=False, downgrade=True)
        self.assertNotIn("usersessionpush", self.db.get_tables())
        self.assertNotIn(NAME, self.router.done)

    def test_fresh_schema_matches_the_migration(self):
        self.router.run_one(NAME, self.router.migrator, fake=False)
        migrated = {
            (column.name, column.data_type, column.null)
            for column in self.db.get_columns("usersessionpush")
        }
        migrated_indexes = {
            index.name for index in self.db.get_indexes("usersessionpush")
        }

        fresh_db = SqliteDatabase(":memory:")
        self.addCleanup(fresh_db.close)
        with fresh_db.bind_ctx([UserSessionPush]):
            fresh_db.create_tables([UserSessionPush])
        fresh = {
            (column.name, column.data_type, column.null)
            for column in fresh_db.get_columns("usersessionpush")
        }
        fresh_indexes = {
            index.name for index in fresh_db.get_indexes("usersessionpush")
        }

        self.assertEqual(migrated, fresh)
        self.assertEqual(migrated_indexes, fresh_indexes)

    def test_fake_run_leaves_the_database_alone(self):
        self.router.run_one(NAME, self.router.migrator, fake=True)
        self.assertNotIn("usersessionpush", self.db.get_tables())


if __name__ == "__main__":
    unittest.main()
