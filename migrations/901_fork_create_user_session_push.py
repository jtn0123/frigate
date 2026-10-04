"""Peewee migrations -- 901_fork_create_user_session_push.py.

Fork E27: which session each push subscription belongs to, so signing a
device out stops its notifications (see frigate/fork/session_reach.py).

Numbered after the sessions table (900) for the same reason: it can never
take the number of an upstream migration. The table stands alone, keyed by
the subscription's endpoint, so ``User.notification_tokens`` stays as
upstream has it.
"""

import peewee as pw

SQL = pw.SQL


# peewee_migrate calls migrate(migrator, database, fake=...) and rollback the
# same way. Both only queue SQL on the migrator (which also handles fake runs),
# so the database and fake arguments are accepted and not used.
def migrate(migrator, *_args, **_kwargs):
    migrator.sql(
        """
        CREATE TABLE IF NOT EXISTS "usersessionpush" (
            "endpoint" VARCHAR(2048) NOT NULL PRIMARY KEY,
            "username" VARCHAR(30) NOT NULL,
            "session_id" VARCHAR(64),
            "updated_at" REAL NOT NULL
        )
        """
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "usersessionpush_username" '
        'ON "usersessionpush" ("username")'
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "usersessionpush_session_id" '
        'ON "usersessionpush" ("session_id")'
    )


def rollback(migrator, *_args, **_kwargs):
    # The table's indexes are dropped with it.
    migrator.sql('DROP TABLE IF EXISTS "usersessionpush"')
