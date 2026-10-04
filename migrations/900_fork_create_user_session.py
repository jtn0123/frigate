"""Peewee migrations -- 900_fork_create_user_session.py.

Fork E26: one row per signed-in session (see frigate/fork/sessions.py).

Numbered 900 rather than after upstream's latest so it can never take the
number of an upstream migration, and sorts after all of them. The table
stands alone, so it does not matter which migrations run before it.
"""

import peewee as pw

SQL = pw.SQL


# peewee_migrate calls migrate(migrator, database, fake=...) and rollback the
# same way. Both only queue SQL on the migrator (which also handles fake runs),
# so the database and fake arguments are accepted and not used.
def migrate(migrator, *_args, **_kwargs):
    migrator.sql(
        """
        CREATE TABLE IF NOT EXISTS "usersession" (
            "id" VARCHAR(64) NOT NULL PRIMARY KEY,
            "username" VARCHAR(30) NOT NULL,
            "created_at" REAL NOT NULL,
            "last_seen" REAL NOT NULL,
            "expires_at" REAL NOT NULL,
            "user_agent" VARCHAR(512) NOT NULL,
            "ip" VARCHAR(64) NOT NULL,
            "revoked_at" REAL
        )
        """
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "usersession_username" '
        'ON "usersession" ("username")'
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "usersession_expires_at" '
        'ON "usersession" ("expires_at")'
    )


def rollback(migrator, *_args, **_kwargs):
    # The table's indexes are dropped with it.
    migrator.sql('DROP TABLE IF EXISTS "usersession"')
