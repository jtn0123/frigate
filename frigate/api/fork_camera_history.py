"""Fork (UI131): per-camera health history for the System page's Health tab."""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import allow_any_authenticated, get_allowed_cameras_for_filter
from frigate.api.defs.response.fork_camera_history_response import (
    CameraHistoryResponse,
)
from frigate.api.defs.tags import Tags
from frigate.stats.camera_history import DEFAULT_RANGE, RANGE_SPEC

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.app])


@router.get(
    "/fork/camera_history",
    response_model=CameraHistoryResponse,
    dependencies=[Depends(allow_any_authenticated())],
)
async def camera_history(
    request: Request,
    range: str = DEFAULT_RANGE,
    allowed_cameras: list[str] = Depends(get_allowed_cameras_for_filter),
) -> JSONResponse:
    """Return frame rate, uptime and incidents per camera over one window.

    Args:
        request: The incoming request, carrying the stats emitter.
        range: Window to aggregate: '1h', '6h', '24h' or '7d'.
        allowed_cameras: Cameras this caller may see.

    Returns:
        The history for every camera the caller has access to.
    """
    if range not in RANGE_SPEC:
        range = DEFAULT_RANGE

    history = getattr(request.app.stats_emitter, "camera_history", None)
    if history is None:
        logger.debug("Camera history is not collecting yet")
        return JSONResponse(
            content={
                "range": range,
                "start": 0,
                "end": 0,
                "cell_seconds": 0,
                "bucket_seconds": 0,
                "cameras": {},
            }
        )

    data: dict[str, Any] = await asyncio.to_thread(history.read, range)

    if request.headers.get("remote-role") != "admin":
        allowed = set(allowed_cameras)
        data = {
            **data,
            "cameras": {
                name: series
                for name, series in data["cameras"].items()
                if name in allowed
            },
        }

    return JSONResponse(content=data)
