"""Expiring public clip share links (fork UI11)."""

import asyncio
import logging
import re
import secrets
import time
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from peewee import DoesNotExist
from pydantic import BaseModel, Field

from frigate.api.auth import (
    allow_any_authenticated,
    allow_public,
    get_current_user,
    require_camera_access,
)
from frigate.api.defs.tags import Tags
from frigate.api.media import recording_clip
from frigate.models import Event, ShareLink

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.share])

TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
DEFAULT_EXPIRES_HOURS = 24
MAX_EXPIRES_HOURS = 168


class ShareCreateBody(BaseModel):
    event_id: str = Field(min_length=1, max_length=30)
    expires_in_hours: int = Field(
        default=DEFAULT_EXPIRES_HOURS,
        ge=1,
        le=MAX_EXPIRES_HOURS,
    )


def _as_unix(value) -> float:
    if isinstance(value, datetime):
        return value.timestamp()
    return float(value)


def _share_url(token: str) -> str:
    return f"/share/{token}"


def _event_payload(event: Event) -> dict:
    return {
        "event_id": event.id,
        "camera": event.camera,
        "label": event.label,
        "start_time": _as_unix(event.start_time),
        "end_time": (None if event.end_time is None else _as_unix(event.end_time)),
        "has_clip": bool(event.has_clip),
    }


def _get_valid_link(token: str) -> tuple[ShareLink | None, str | None]:
    if not TOKEN_RE.fullmatch(token):
        return None, "invalid"
    try:
        link = ShareLink.get(ShareLink.token == token)
    except DoesNotExist:
        return None, "missing"
    if link.expires_at <= time.time():
        return link, "expired"
    return link, None


@router.post("/fork/share", dependencies=[Depends(allow_any_authenticated())])
async def create_share(request: Request, body: ShareCreateBody):
    """Create an expiring public link for an event clip."""
    current_user = await get_current_user(request)
    if isinstance(current_user, JSONResponse):
        return current_user

    try:
        event: Event = await asyncio.to_thread(Event.get, Event.id == body.event_id)
    except DoesNotExist:
        return JSONResponse(
            content={"success": False, "message": "Event not found"},
            status_code=404,
        )

    await require_camera_access(event.camera, request=request)

    if not event.has_clip:
        return JSONResponse(
            content={"success": False, "message": "Clip not available"},
            status_code=400,
        )

    now = time.time()
    token = secrets.token_urlsafe(24)
    expires_at = now + body.expires_in_hours * 3600
    username = current_user["username"]

    def _insert() -> ShareLink:
        return ShareLink.create(
            token=token,
            event_id=event.id,
            camera=event.camera,
            created_by=username,
            created_at=now,
            expires_at=expires_at,
        )

    link = await asyncio.to_thread(_insert)
    logger.info(
        "Created clip share for event %s camera %s expires_at %s",
        event.id,
        event.camera,
        int(expires_at),
    )
    return {
        "token": link.token,
        "url": _share_url(link.token),
        "expires_at": link.expires_at,
        **_event_payload(event),
    }


@router.get(
    "/fork/share/{token}",
    dependencies=[Depends(allow_public())],
)
async def get_share(token: str):
    """Return metadata for a public share link."""

    def _load():
        return _get_valid_link(token)

    link, status = await asyncio.to_thread(_load)
    if status == "invalid" or status == "missing" or link is None:
        return JSONResponse(
            content={"success": False, "message": "Share link not found"},
            status_code=404,
        )
    if status == "expired":
        return JSONResponse(
            content={"success": False, "message": "Share link expired"},
            status_code=410,
        )

    try:
        event: Event = await asyncio.to_thread(Event.get, Event.id == link.event_id)
    except DoesNotExist:
        return JSONResponse(
            content={"success": False, "message": "Event not found"},
            status_code=404,
        )

    return {
        "token": link.token,
        "url": _share_url(link.token),
        "expires_at": link.expires_at,
        **_event_payload(event),
    }


@router.get(
    "/fork/share/{token}/clip.mp4",
    dependencies=[Depends(allow_public())],
)
async def get_share_clip(request: Request, token: str):
    """Stream the shared event clip without a login."""

    def _load():
        return _get_valid_link(token)

    link, status = await asyncio.to_thread(_load)
    if status == "invalid" or status == "missing" or link is None:
        return JSONResponse(
            content={"success": False, "message": "Share link not found"},
            status_code=404,
        )
    if status == "expired":
        return JSONResponse(
            content={"success": False, "message": "Share link expired"},
            status_code=410,
        )

    try:
        event: Event = await asyncio.to_thread(Event.get, Event.id == link.event_id)
    except DoesNotExist:
        return JSONResponse(
            content={"success": False, "message": "Event not found"},
            status_code=404,
        )

    if not event.has_clip:
        return JSONResponse(
            content={"success": False, "message": "Clip not available"},
            status_code=404,
        )

    end_ts = (
        datetime.now().timestamp()
        if event.end_time is None
        else _as_unix(event.end_time)
    )
    return await asyncio.to_thread(
        recording_clip,
        request,
        event.camera,
        _as_unix(event.start_time),
        end_ts,
    )
