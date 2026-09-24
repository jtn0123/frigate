"""Fork (D54): admin-only system metrics over long windows."""

import asyncio
import logging
import sqlite3

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import require_role
from frigate.stats.ai_models import stats_fresh
from frigate.stats.system_history import SAMPLE_INTERVAL, read_history, save_sample

logger = logging.getLogger(__name__)

router = APIRouter(tags=["App"])

# The ranges the System page offers, in seconds. The longest is what the
# default retention keeps.
RANGES = {
    "1h": 3600,
    "6h": 21600,
    "12h": 43200,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
}


@router.get(
    "/system/metrics/history",
    dependencies=[Depends(require_role(["admin"]))],
    summary="System metrics over a range longer than the in-memory history",
)
async def system_metrics_history(
    request: Request,
    window: str = Query(
        default="1h", alias="range", description="One of " + ", ".join(RANGES)
    ),
) -> JSONResponse:
    """Return averaged samples of the graphed metrics for one range."""
    seconds = RANGES.get(window)

    if seconds is None:
        return JSONResponse(
            content={"success": False, "message": "Unknown metrics range"},
            status_code=400,
        )

    if not request.app.frigate_config.telemetry.stats.history.enabled:
        return JSONResponse(
            content={"status": "disabled", "range": window, "samples": []}
        )

    try:
        samples, resolution = await asyncio.to_thread(read_history, seconds)
    except (OSError, sqlite3.Error, ValueError):
        logger.exception("System metrics history unavailable")
        return JSONResponse(
            content={"status": "unavailable", "range": window, "samples": []}
        )

    return JSONResponse(
        content={
            "status": "connected",
            "range": window,
            "resolution": resolution,
            "samples": samples,
        }
    )


async def system_metrics_sampler(app) -> None:
    """Store a minute sample whether or not a browser is on the System page."""
    while True:
        await asyncio.sleep(SAMPLE_INTERVAL)
        history = app.frigate_config.telemetry.stats.history

        if not history.enabled:
            continue

        try:
            stats = await asyncio.to_thread(app.stats_emitter.get_latest_stats)

            # A stale snapshot is the same reading again; storing it would
            # draw a flat line for as long as collection is stuck.
            if stats_fresh(stats):
                await asyncio.to_thread(save_sample, stats, history.retain_days)
        except Exception:
            # A monitoring failure must not terminate the NVR API or sampler.
            logger.exception("System metrics sample unavailable")
