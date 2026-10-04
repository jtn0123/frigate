"""Fork (D78): the timezone and current state of notification quiet hours."""

import datetime as dt

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import require_role
from frigate.api.defs.response.fork_notification_schedule_response import (
    NotificationScheduleResponse,
)
from frigate.api.defs.tags import Tags
from frigate.config import FrigateConfig
from frigate.fork.notification_schedule import is_quiet, resolve_timezone

router = APIRouter(tags=[Tags.notifications])


@router.get(
    "/fork/notifications/schedule",
    response_model=NotificationScheduleResponse,
    dependencies=[Depends(require_role(["admin"]))],
)
def notification_schedule(request: Request) -> JSONResponse:
    """Return the timezone quiet hours use and whether each camera is quiet.

    The browser cannot know the server's local time, which is what quiet
    hours use when `ui.timezone` is not set, so the schedule editor in the
    notification settings reads it here. Admin only, like that editor.

    Args:
        request: The incoming request, carrying the config.

    Returns:
        The timezone, where it came from, and the state of every camera.
    """
    config: FrigateConfig = request.app.frigate_config
    tz, name, source = resolve_timezone(config.ui.timezone)
    now = dt.datetime.now(dt.UTC)

    cameras = {
        camera: {
            "quiet": is_quiet(now, camera_config.notifications.quiet_hours, tz),
            "windows": len(camera_config.notifications.quiet_hours),
        }
        for camera, camera_config in config.cameras.items()
    }

    return JSONResponse(
        content={
            "timezone": name,
            "source": source,
            "now": now.timestamp(),
            "cameras": cameras,
        }
    )
