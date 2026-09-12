"""Migration 036 (fork UI11), run and rolled back through peewee_migrate's
Router the way Frigate's startup runs migrations."""

import os
import unittest

from peewee import SqliteDatabase
from peewee_migrate import Router

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "migrations"
)
NAME = "036_create_share_link"
INDEXES = {"sharelink_event_id", "sharelink_camera", "sharelink_expires_at"}


class TestShareLinkMigration(unittest.TestCase):
    def setUp(self):
        self.db = SqliteDatabase(":memory:")
        self.router = Router(self.db, migrate_dir=MIGRATIONS_DIR)

    def tearDown(self):
        self.db.close()

    def test_migrate_creates_table_and_rollback_drops_it(self):
        self.router.run_one(NAME, self.router.migrator, fake=False)
        self.assertIn("sharelink", self.db.get_tables())
        self.assertLessEqual(
            INDEXES, {index.name for index in self.db.get_indexes("sharelink")}
        )
        self.assertIn(NAME, self.router.done)

        self.router.run_one(NAME, self.router.migrator, fake=False, downgrade=True)
        self.assertNotIn("sharelink", self.db.get_tables())
        self.assertNotIn(NAME, self.router.done)

    def test_fake_run_leaves_the_database_alone(self):
        self.router.run_one(NAME, self.router.migrator, fake=True)
        self.assertNotIn("sharelink", self.db.get_tables())


if __name__ == "__main__":
    unittest.main()
