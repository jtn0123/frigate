"""Fork (I57): go2rtc source state per camera for the Health drawer."""

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import allow_any_authenticated, get_allowed_cameras_for_filter
from frigate.api.defs.response.fork_go2rtc_state_response import Go2rtcStateResponse
from frigate.api.defs.tags import Tags
from frigate.fork.go2rtc_state import (
    Go2rtcStateReader,
    camera_states,
    camera_stream_names,
    configured_sources,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.app])


def get_reader(app: FastAPI) -> Go2rtcStateReader:
    """Return the app's go2rtc reader, creating it on first use.

    The reader holds the five second cache and the previous byte counters, so
    every request has to share one.
    """
    reader: Go2rtcStateReader | None = getattr(app.state, "fork_go2rtc_state", None)
    if reader is None:
        reader = Go2rtcStateReader()
        app.state.fork_go2rtc_state = reader
    return reader


@router.get(
    "/fork/go2rtc_state",
    response_model=Go2rtcStateResponse,
    dependencies=[Depends(allow_any_authenticated())],
)
async def go2rtc_state(
    request: Request,
    allowed_cameras: Annotated[list[str], Depends(get_allowed_cameras_for_filter)],
) -> JSONResponse:
    """Return whether go2rtc is connected to each camera's source.

    Sources are reduced to scheme and host; credentials never leave the
    backend. An unreachable go2rtc gives `available: false`, not an error.

    Args:
        request: The incoming request, carrying the config and the reader.
        allowed_cameras: Cameras this caller may see.

    Returns:
        The stream states of every camera the caller has access to.
    """
    config = request.app.frigate_config
    snapshot: dict[str, Any] = await asyncio.to_thread(get_reader(request.app).read)

    stream_names = camera_stream_names(config)
    if request.headers.get("remote-role") != "admin":
        allowed = set(allowed_cameras)
        stream_names = {
            name: streams for name, streams in stream_names.items() if name in allowed
        }

    content = camera_states(snapshot, stream_names, configured_sources(config))
    # fork (I60): the last ping of each camera's host, next to its streams
    pings = getattr(request.app.state, "fork_camera_ping", {})
    for name, camera in content["cameras"].items():
        camera["ping"] = pings.get(name)

    return JSONResponse(content=content)
