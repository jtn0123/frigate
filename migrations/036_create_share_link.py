"""Peewee migrations -- 036_create_share_link.py.

Some examples (model - class or model name)::

    > Model = migrator.orm['model_name']            # Return model in current state by name

    > migrator.sql(sql)                             # Run custom SQL
    > migrator.python(func, *args, **kwargs)        # Run python code
    > migrator.create_model(Model)                  # Create a model (could be used as decorator)
    > migrator.remove_model(model, cascade=True)    # Remove a model
    > migrator.add_fields(model, **fields)          # Add fields to a model
    > migrator.change_fields(model, **fields)       # Change fields
    > migrator.remove_fields(model, *field_names, cascade=True)
    > migrator.rename_field(model, old_field_name, new_field_name)
    > migrator.rename_table(model, new_table_name)
    > migrator.add_index(model, *col_names, unique=False)
    > migrator.drop_index(model, *col_names)
    > migrator.add_not_null(model, *field_names)
    > migrator.drop_not_null(model, *field_names)
    > migrator.add_default(model, field_name, default)

"""

import peewee as pw

SQL = pw.SQL


# peewee_migrate calls migrate(migrator, database, fake=...) and rollback the
# same way. Both only queue SQL on the migrator (which also handles fake runs),
# so the database and fake arguments are accepted and not used.
def migrate(migrator, *_args, **_kwargs):
    migrator.sql(
        """
        CREATE TABLE IF NOT EXISTS "sharelink" (
            "token" VARCHAR(64) NOT NULL PRIMARY KEY,
            "event_id" VARCHAR(30) NOT NULL,
            "camera" VARCHAR(20) NOT NULL,
            "created_by" VARCHAR(30) NOT NULL,
            "created_at" REAL NOT NULL,
            "expires_at" REAL NOT NULL
        )
        """
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "sharelink_event_id" ON "sharelink" ("event_id")'
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "sharelink_camera" ON "sharelink" ("camera")'
    )
    migrator.sql(
        'CREATE INDEX IF NOT EXISTS "sharelink_expires_at" ON "sharelink" ("expires_at")'
    )


def rollback(migrator, *_args, **_kwargs):
    # The table's indexes are dropped with it.
    migrator.sql('DROP TABLE IF EXISTS "sharelink"')
