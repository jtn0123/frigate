"""Expiring public clip share links (fork UI11)."""

import asyncio
import logging
import re
import secrets
import threading
import time
from collections.abc import AsyncIterator
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
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
EVENT_NOT_FOUND = "Event not found"
SHARE_NOT_FOUND = "Share link not found"
# A public link serves at most this much of the event's recordings. An event
# that never closed has no end, so without the cap its clip would grow with
# every request.
MAX_SHARE_CLIP_SECONDS = 600
# Each public clip request runs one ffmpeg remux for as long as the client
# reads it, and nothing else limits how many run at once.
MAX_CONCURRENT_SHARE_CLIPS = 4
# threading, not asyncio: a slot is given back by whichever thread drops the
# response stream, and nothing ever waits on it (a full house answers 429).
_clip_slots = threading.BoundedSemaphore(MAX_CONCURRENT_SHARE_CLIPS)


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


def share_clip_range(event: Event, now: float) -> tuple[float, float]:
    """Return the capped start and end timestamps a share link may serve."""
    start_ts = _as_unix(event.start_time)
    end_ts = now if event.end_time is None else _as_unix(event.end_time)
    return start_ts, min(end_ts, start_ts + MAX_SHARE_CLIP_SECONDS)


class _SlotStream:
    """Response body that gives its clip slot back when the stream ends.

    A generator's `finally` never runs when the client leaves before the first
    chunk is read, so the slot is released from here instead: when the body is
    exhausted, fails or is cancelled, and as a last resort when the stream is
    garbage collected without having been read.
    """

    def __init__(self, body: AsyncIterator[bytes]) -> None:
        self._body = body
        self._released = False

    def release(self) -> None:
        """Give the slot back, once."""
        if not self._released:
            self._released = True
            _clip_slots.release()

    def __aiter__(self) -> "_SlotStream":
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self._body.__anext__()
        except BaseException:
            # StopAsyncIteration, a client disconnect (CancelledError) or a
            # failed read all end the stream
            self.release()
            raise

    def __del__(self) -> None:
        self.release()


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


def _error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        content={"success": False, "message": message},
        status_code=status_code,
    )


def _load_shared(token: str) -> tuple[ShareLink, Event] | JSONResponse:
    """Resolve a public token to its link and event, or to the error to send."""
    link, status = _get_valid_link(token)
    if link is None or status in ("invalid", "missing"):
        return _error(SHARE_NOT_FOUND, 404)
    if status == "expired":
        return _error("Share link expired", 410)

    try:
        event: Event = Event.get(Event.id == link.event_id)
    except DoesNotExist:
        return _error(EVENT_NOT_FOUND, 404)

    # the link was issued for one camera's clip, so an event id that now
    # points at another camera is not what was shared
    if event.camera != link.camera:
        return _error(SHARE_NOT_FOUND, 404)

    return link, event


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
            content={"success": False, "message": EVENT_NOT_FOUND},
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
    shared = await asyncio.to_thread(_load_shared, token)
    if isinstance(shared, JSONResponse):
        return shared
    link, event = shared

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
    shared = await asyncio.to_thread(_load_shared, token)
    if isinstance(shared, JSONResponse):
        return shared
    _link, event = shared

    if not event.has_clip:
        return JSONResponse(
            content={"success": False, "message": "Clip not available"},
            status_code=404,
        )

    start_ts, end_ts = share_clip_range(event, time.time())

    if not _clip_slots.acquire(blocking=False):
        return JSONResponse(
            content={"success": False, "message": "Too many clip requests"},
            status_code=429,
            headers={"Retry-After": "5"},
        )

    try:
        response = await asyncio.to_thread(
            recording_clip,
            request,
            event.camera,
            start_ts,
            end_ts,
        )
    except BaseException:
        _clip_slots.release()
        raise

    if isinstance(response, StreamingResponse):
        # ffmpeg runs for as long as the body is read, so the slot goes with it
        response.body_iterator = _SlotStream(response.body_iterator)
    else:
        _clip_slots.release()

    return response
