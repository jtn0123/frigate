"""Fork (D75): crossing counts for line zones.

A counted crossing adds the line's name to the tracked object's zones, which
the event maintainer already stores in ``Event.zones``. Counting those rows
needs no new table or migration, and the numbers match what the Explore and
``/events?zones=<line>`` filters list for the same window: one per tracked
object that crossed in a counted direction, by the object's start time. An
object that crosses back and forth counts once; a count of people in and out
is two lines on the same spot, one per direction.
"""

import asyncio
import datetime
import logging
import operator
from functools import reduce
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import allow_any_authenticated, get_allowed_cameras_for_filter
from frigate.api.defs.response.fork_line_crossings_response import (
    LineCrossingsResponse,
)
from frigate.api.defs.tags import Tags
from frigate.config import FrigateConfig
from frigate.fork.line_crossing import line_zone_names
from frigate.models import Event

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.events])

DEFAULT_WINDOW_SECONDS = 24 * 3600


def _split(value: str | None) -> set[str] | None:
    """Parse a comma separated filter; None or 'all' means no filter."""
    if value is None or value in ("", "all"):
        return None

    return {item for item in value.split(",") if item}


def count_line_crossings(
    config: FrigateConfig,
    cameras: list[str],
    zones: set[str] | None,
    after: float,
    before: float,
) -> list[dict[str, Any]]:
    """Count tracked objects per line zone and label.

    Args:
        config: The running config, for the cameras' line zones.
        cameras: Cameras to count, already limited to what the caller may see.
        zones: Line zone names to keep, or None for every line.
        after: Window start (exclusive), Unix timestamp.
        before: Window end (exclusive), Unix timestamp.

    Returns:
        One entry per line zone, in camera then zone order, zero counts
        included.
    """
    lines: dict[tuple[str, str], dict[str, Any]] = {}

    for camera in cameras:
        camera_config = config.cameras.get(camera)

        if camera_config is None:
            continue

        for name in line_zone_names(camera_config.zones):
            if zones is not None and name not in zones:
                continue

            lines[(camera, name)] = {
                "camera": camera,
                "zone": name,
                "direction": camera_config.zones[name].direction,
                "total": 0,
                "labels": {},
            }

    if not lines:
        return []

    line_cameras = sorted({camera for camera, _ in lines})
    line_names = sorted({name for _, name in lines})
    zone_clause = reduce(
        operator.or_,
        [Event.zones.cast("text") % f'*"{name}"*' for name in line_names],
    )
    rows = (
        Event.select(Event.camera, Event.label, Event.zones)
        .where(
            Event.camera.in_(line_cameras),
            Event.start_time > after,
            Event.start_time < before,
            zone_clause,
        )
        .tuples()
        .iterator()
    )

    for camera, label, event_zones in rows:
        for name in event_zones or []:
            entry = lines.get((camera, name))

            if entry is None:
                continue

            entry["total"] += 1
            entry["labels"][label] = entry["labels"].get(label, 0) + 1

    return list(lines.values())


@router.get(
    "/fork/line_crossings",
    response_model=LineCrossingsResponse,
    dependencies=[Depends(allow_any_authenticated())],
)
async def line_crossings(
    request: Request,
    allowed_cameras: Annotated[list[str], Depends(get_allowed_cameras_for_filter)],
    camera: Annotated[str | None, Query()] = None,
    zone: Annotated[str | None, Query()] = None,
    after: Annotated[float | None, Query()] = None,
    before: Annotated[float | None, Query()] = None,
) -> JSONResponse:
    """Return how many tracked objects crossed each line zone.

    Args:
        request: The incoming request, carrying the config.
        allowed_cameras: Cameras this caller may see.
        camera: Comma separated cameras, or all (the default).
        zone: Comma separated line zone names, or all (the default).
        after: Window start, Unix timestamp; defaults to 24 hours before
            ``before``.
        before: Window end, Unix timestamp; defaults to now.

    Returns:
        Counts per line and label for the cameras the caller may see.
    """
    end = before if before is not None else datetime.datetime.now().timestamp()
    start = after if after is not None else end - DEFAULT_WINDOW_SECONDS
    requested = _split(camera)
    cameras = [
        name
        for name in request.app.frigate_config.cameras
        if name in allowed_cameras and (requested is None or name in requested)
    ]
    lines = await asyncio.to_thread(
        count_line_crossings,
        request.app.frigate_config,
        cameras,
        _split(zone),
        start,
        end,
    )
    return JSONResponse(content={"after": start, "before": end, "lines": lines})
