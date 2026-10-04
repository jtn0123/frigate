"""List and revoke signed-in sessions (fork E26).

An admin sees and revokes everyone's sessions; any other user only their
own. Someone else's session reads as unknown, so its existence stays private.
A revoke also closes the sessions' open connections and stops their
notifications (fork E27).
"""

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from frigate.api.auth import allow_any_authenticated, get_current_user
from frigate.api.defs.response.fork_sessions_response import (
    SessionListResponse,
    SessionPushResponse,
    SessionRevokeAllResponse,
)
from frigate.api.defs.response.generic_response import GenericResponse
from frigate.api.defs.tags import Tags
from frigate.api.notification import _validate_subscription
from frigate.fork.session_reach import reattach_push
from frigate.fork.sessions import (
    DB_ERRORS,
    SessionInfo,
    current_session_id,
    log_safe,
    session_store,
    sessions_ended,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.auth])

SESSION_NOT_FOUND = "Session not found"
SESSIONS_UNAVAILABLE = "Sessions are unavailable"


class SessionRevokeAllBody(BaseModel):
    username: str | None = Field(
        default=None,
        max_length=30,
        description="User to sign out; the caller when omitted. Only an admin may name another user",
    )
    keep_current: bool = Field(
        default=False,
        description="Keep the caller's own session, to sign out only the others",
    )


class SessionPushBody(BaseModel):
    sub: dict[str, Any] = Field(
        description="The browser's push subscription, as PushSubscription.toJSON() gives it",
    )


def _error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        content={"success": False, "message": message},
        status_code=status_code,
    )


def _payload(session: SessionInfo, current: str | None) -> dict:
    return {
        "id": session.id,
        "username": session.username,
        "created_at": session.created_at,
        "last_seen": session.last_seen,
        "expires_at": session.expires_at,
        "user_agent": session.user_agent,
        "ip": session.ip,
        "current": session.id == current,
    }


@router.get(
    "/fork/sessions",
    response_model=SessionListResponse,
    dependencies=[Depends(allow_any_authenticated())],
    summary="List signed-in sessions",
)
async def list_sessions(
    request: Request, response: Response
) -> JSONResponse | list[dict]:
    """List usable sessions, most recently active first.

    An admin gets every user's sessions, anyone else only their own. The
    caller's own session is marked `current`.
    """
    # nginx caches /api/ reads for 5 s per user, not per session, so another
    # of the user's sessions could be served this one's `current` flag
    response.headers["Cache-Control"] = "no-store"
    current_user = await get_current_user(request)
    if isinstance(current_user, JSONResponse):
        return current_user

    store = session_store(request.app)
    username = None if current_user["role"] == "admin" else current_user["username"]
    current = current_session_id(request)

    try:
        sessions = await asyncio.to_thread(store.list, time.time(), username)
    except DB_ERRORS:
        logger.exception("Unable to list sessions")
        return _error(SESSIONS_UNAVAILABLE, 500)

    return [_payload(session, current) for session in sessions]


@router.delete(
    "/fork/sessions/{session_id}",
    response_model=GenericResponse,
    dependencies=[Depends(allow_any_authenticated())],
    summary="Revoke a session",
)
async def revoke_session(request: Request, session_id: str) -> JSONResponse | dict:
    """Sign one session out. Its tokens stop working on their next request.

    Only the session's user or an admin may; anyone else gets the same 404
    as for an unknown session.
    """
    current_user = await get_current_user(request)
    if isinstance(current_user, JSONResponse):
        return current_user

    store = session_store(request.app)
    now = time.time()
    session_length = request.app.frigate_config.auth.session_length

    def _revoke() -> SessionInfo | None:
        session = store.get(session_id, now)

        if session is None:
            return None

        if (
            current_user["role"] != "admin"
            and session.username != current_user["username"]
        ):
            return None

        store.revoke({session.id: session.expires_at}, now, session_length)
        sessions_ended(request.app, {session.id})
        return session

    try:
        revoked = await asyncio.to_thread(_revoke)
    except DB_ERRORS:
        logger.exception("Unable to revoke a session")
        return _error(SESSIONS_UNAVAILABLE, 500)

    if revoked is None:
        return _error(SESSION_NOT_FOUND, 404)

    logger.info(
        "User %s revoked a session of %s", current_user["username"], revoked.username
    )
    return {"success": True, "message": "Session revoked"}


@router.post(
    "/fork/sessions/revoke_all",
    response_model=SessionRevokeAllResponse,
    dependencies=[Depends(allow_any_authenticated())],
    summary="Sign a user out everywhere",
)
async def revoke_all_sessions(
    request: Request, body: SessionRevokeAllBody
) -> JSONResponse | dict:
    """Revoke every session of a user, or every one but the caller's own.

    A user may sign themselves out; an admin may sign out anyone. Signing
    out everywhere also refuses older tokens that have no session, until
    the next restart.
    """
    current_user = await get_current_user(request)
    if isinstance(current_user, JSONResponse):
        return current_user

    username = body.username or current_user["username"]

    if current_user["role"] != "admin" and username != current_user["username"]:
        return _error("Users can only sign out their own sessions", 403)

    store = session_store(request.app)
    keep = current_session_id(request) if body.keep_current else None
    now = time.time()

    if not body.keep_current:
        # tokens from before sessions existed carry no session to revoke;
        # refuse every token issued until now, as a password change does
        store.refuse_issued_before(username, int(now))

    try:
        revoked = await asyncio.to_thread(
            store.revoke_user,
            username,
            now,
            request.app.frigate_config.auth.session_length,
            keep,
        )
    except DB_ERRORS:
        logger.exception("Unable to revoke sessions")
        return _error(SESSIONS_UNAVAILABLE, 500)

    await asyncio.to_thread(sessions_ended, request.app, (), username, keep)

    logger.info(
        "User %s revoked %s sessions of %s",
        log_safe(current_user["username"]),
        revoked,
        log_safe(username),
    )
    return {"success": True, "revoked": revoked}


@router.put(
    "/fork/sessions/push",
    response_model=SessionPushResponse,
    dependencies=[Depends(allow_any_authenticated())],
    summary="Tie this device's notifications to its session",
)
async def link_session_push(
    request: Request, body: SessionPushBody
) -> JSONResponse | dict:
    """Tie this device's push subscription to the session it is signed in with.

    The web app sends it each time it connects, so signing this device out
    stops its notifications. A subscription the user lost when one of their
    sessions ended is restored; anyone else's, or one never registered, is
    left alone (`linked` is false).
    """
    current_user = await get_current_user(request)
    if isinstance(current_user, JSONResponse):
        return current_user

    reason = _validate_subscription(body.sub)

    if reason:
        return _error(f"Invalid subscription: {reason}", 400)

    username = current_user["username"]
    session_id = current_session_id(request, username)

    if session_id is None:
        # signed in without a session (a proxy, or a token from before them)
        return {"success": True, "linked": False}

    try:
        linked = await asyncio.to_thread(
            reattach_push, request.app, username, session_id, body.sub
        )
    except DB_ERRORS:
        logger.exception("Unable to link a notification subscription")
        return _error(SESSIONS_UNAVAILABLE, 500)

    return {"success": True, "linked": linked}
