"""Fork (I58): repeated log lines collapsed per camera and hour, for the Logs page."""

import asyncio
import logging
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import require_role
from frigate.api.defs.response.fork_log_summary_response import LogSummaryResponse
from frigate.api.defs.tags import Tags
from frigate.const import REGEX_CAMERA_NAME
from frigate.fork.log_summary import (
    DEFAULT_HOURS,
    DEFAULT_MIN_COUNT,
    MAX_HOURS,
    CameraMatcher,
    summarize_logs,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.logs])

# Reading up to 10 MB per log is cheap but not free, and the panel polls.
CACHE_SECONDS = 30
_CACHE_MAX = 32
# (hours, camera, min_count) -> (monotonic time it expires, payload)
_cache: dict[tuple[int, str | None, int], tuple[float, dict[str, Any]]] = {}


def clear_cache() -> None:
    """Forget every cached summary (for tests)."""
    _cache.clear()


def _summarize(
    config: Any, hours: int, camera: str | None, min_count: int
) -> dict[str, Any]:
    return summarize_logs(
        hours=hours,
        camera=camera,
        min_count=min_count,
        matcher=CameraMatcher.from_config(config),
    )


@router.get(
    "/fork/log_summary",
    response_model=LogSummaryResponse,
    dependencies=[Depends(require_role(["admin"]))],
)
async def log_summary(
    request: Request,
    hours: Annotated[int, Query(ge=1, le=MAX_HOURS)] = DEFAULT_HOURS,
    camera: Annotated[
        str | None, Query(max_length=64, pattern=REGEX_CAMERA_NAME)
    ] = None,
    min_count: Annotated[int, Query(ge=1, le=1_000_000)] = DEFAULT_MIN_COUNT,
) -> JSONResponse:
    """Return repeated warning and error log lines grouped per camera and hour.

    Reads the end of the frigate and go2rtc logs. Admin only, like the logs
    themselves. Messages are stripped of credentials and query strings.

    Args:
        request: The incoming request, carrying the config.
        hours: How far back to look.
        camera: Only count lines attributed to this camera.
        min_count: Leave out groups seen fewer times than this.

    Returns:
        The groups with the highest counts, totals per camera and how far
        back the logs actually reach.
    """
    key = (hours, camera, min_count)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached is not None and cached[0] > now:
        return JSONResponse(content=cached[1])

    data = await asyncio.to_thread(
        _summarize, request.app.frigate_config, hours, camera, min_count
    )

    for stale in [k for k, (expires, _) in _cache.items() if expires <= now]:
        del _cache[stale]
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()
    _cache[key] = (now + CACHE_SECONDS, data)
    return JSONResponse(content=data)
