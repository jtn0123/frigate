"""Rename an export file and its database row in a worker thread."""

import contextlib
import logging
import os

from fastapi.responses import JSONResponse
from peewee import DatabaseError, IntegrityError

from frigate.models import Export
from frigate.record.export import export_video_path

logger = logging.getLogger(__name__)


def rename_export_file(export: Export, name: str) -> JSONResponse:
    """Rename the file first and restore it if the database update fails."""
    event_id = export.id
    if export.in_progress:
        return JSONResponse(
            content={
                "success": False,
                "message": "Export is still being written and can't be renamed yet.",
            },
            status_code=400,
        )

    new_path = export_video_path(name, export.id)
    old_path = export.video_path
    moved = new_path != old_path

    # move the file first so a rename that can't happen leaves the row alone
    if moved:
        try:
            os.rename(old_path, new_path)
        except OSError:
            logger.exception("Failed to rename export file for %s", event_id)
            return JSONResponse(
                content={"success": False, "message": "Failed to rename export."},
                status_code=500,
            )

    export.name = name
    export.video_path = new_path

    try:
        export.save()
    except DatabaseError as err:
        # the queue database has no transactions, so undo the move by hand
        if moved:
            with contextlib.suppress(OSError):
                os.rename(new_path, old_path)

        if isinstance(err, IntegrityError):
            logger.warning(
                "Export %s cannot be renamed, %s is taken", event_id, new_path
            )
            return JSONResponse(
                content={
                    "success": False,
                    "message": "Another export already uses that name.",
                },
                status_code=409,
            )

        logger.exception("Failed to save renamed export %s", event_id)
        return JSONResponse(
            content={"success": False, "message": "Failed to rename export."},
            status_code=500,
        )

    return JSONResponse(
        content=(
            {
                "success": True,
                "message": "Successfully renamed export.",
            }
        ),
        status_code=200,
    )
