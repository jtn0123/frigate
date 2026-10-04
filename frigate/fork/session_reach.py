"""Cut what an ended session still holds open (fork E27).

nginx checks the session on every request, but a websocket is one request,
so an open ``/ws`` connection outlives a revoke of the session that opened
it. So do the push subscriptions its device registered, which belong to the
user rather than to a sign-in. When sessions end (frigate/fork/sessions.py
decides when), this module:

- closes their ``/ws`` connections with code 4401. The web app then finds it
  is signed out and goes to the login page, which also stops the live video
  it was playing.
- detaches the push subscriptions they registered. A subscription is linked
  to the session that last registered it, or that last opened the app on
  that device. When that session ends it leaves ``User.notification_tokens``
  and the link stays, with no session. If the same user signs in on that
  device again, the web app hands the subscription back and it is restored.
  Anyone else signing in there does not get it.

The communicators are found by attribute on the app's dispatcher rather than
by class, since frigate/comms/ws.py imports this module (through sessions).
"""

import logging
import socket
import sqlite3
import time
from collections.abc import Collection, Mapping
from typing import Any, cast

from peewee import (
    CharField,
    FloatField,
    InterfaceError,
    Model,
    PeeweeException,
)
from pywebpush import WebPusher, WebPushException

from frigate.models import User

logger = logging.getLogger(__name__)

# The close code the web app reads as "your session ended" (4000-4999 are
# for applications).
SESSION_CLOSE_CODE = 4401
SESSION_CLOSE_REASON = "session ended"

# nginx passes these from the /auth subrequest (auth_request.conf); ws4py
# keeps the upgrade request's headers in the socket's WSGI environ.
SESSION_ENVIRON = "HTTP_REMOTE_SESSION"
USER_ENVIRON = "HTTP_REMOTE_USER"

DB_ERRORS = (PeeweeException, sqlite3.Error)


class UserSessionPush(Model):
    """A push subscription, by endpoint, and the session it belongs to."""

    endpoint = CharField(null=False, primary_key=True, max_length=2048)
    username = CharField(index=True, max_length=30)
    # None once that session ended: the subscription was detached, and is
    # restored only to this user signing in on the device again
    session_id = CharField(index=True, null=True, max_length=64)
    updated_at = FloatField()


def _push_table() -> type[UserSessionPush]:
    """Return the link model, bound to the accounts' database."""
    database = cast(Any, User)._meta.database

    if database is None:
        raise InterfaceError("The user table is not bound to a database")

    if cast(Any, UserSessionPush)._meta.database is not database:
        UserSessionPush.bind(database)

    return UserSessionPush


def _comm(app: Any, attribute: str) -> Any | None:
    """Return the app's communicator that has ``attribute``, if any."""
    dispatcher = getattr(app, "dispatcher", None)

    for comm in getattr(dispatcher, "comms", None) or ():
        if hasattr(comm, attribute):
            return comm

    return None


# ---- /ws connections ------------------------------------------------------


def socket_session(ws: Any) -> str | None:
    """Return the session a ``/ws`` connection was opened with, if any."""
    environ = getattr(ws, "environ", None) or {}
    session_id = environ.get(SESSION_ENVIRON)
    return session_id if isinstance(session_id, str) and session_id else None


def cut_socket(ws: Any) -> None:
    """Close a connection and stop reading from it.

    ws4py keeps reading after its close frame until the client answers, so
    the socket is also shut down: a client that never answers is dropped
    instead of keeping the connection.
    """
    # ws4py logs and swallows a failed write itself
    ws.close(code=SESSION_CLOSE_CODE, reason=SESSION_CLOSE_REASON)
    sock = getattr(ws, "sock", None)

    if sock is None:
        return

    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        # already closed by the client
        pass


def _socket_ended(
    ws: Any, session_ids: Collection[str], username: str | None, keep: str | None
) -> bool:
    session_id = socket_session(ws)

    if session_id is not None and session_id in session_ids:
        return True

    if username is None:
        return False

    environ = getattr(ws, "environ", None) or {}

    if environ.get(USER_ENVIRON) != username:
        return False

    # a connection without a session is closed too: it reconnects if its
    # token is still good, which a sign out everywhere decides, not this
    return keep is None or session_id != keep


def close_session_sockets(
    app: Any,
    session_ids: Collection[str],
    username: str | None = None,
    keep: str | None = None,
) -> int:
    """Close the ``/ws`` connections of ended sessions; return how many.

    ``session_ids`` names the sessions. With ``username``, every connection
    of that user is closed but those of the session ``keep``.
    """
    server = getattr(_comm(app, "websocket_server"), "websocket_server", None)

    if server is None:
        return 0

    manager = server.manager

    with manager.lock:
        sockets = list(manager.websockets.values())

    ended = [ws for ws in sockets if _socket_ended(ws, session_ids, username, keep)]

    for ws in ended:
        cut_socket(ws)

    return len(ended)


# ---- push subscriptions ---------------------------------------------------


def _endpoint(subscription: Any) -> str | None:
    if not isinstance(subscription, Mapping):
        return None

    endpoint = subscription.get("endpoint")
    return endpoint if isinstance(endpoint, str) else None


def _link(endpoint: str, username: str, session_id: str | None, now: float) -> None:
    table = _push_table()
    table.insert(
        endpoint=endpoint, username=username, session_id=session_id, updated_at=now
    ).on_conflict_replace().execute()


def _add_pusher(app: Any, username: str, subscription: Mapping[str, Any]) -> None:
    """Start pushing to a subscription now, rather than after a restart."""
    client = _comm(app, "web_pushers")

    if client is None:
        return

    pushers = client.web_pushers.get(username)

    # A user added since startup has no list, and adding a key could break
    # a sender iterating the dict, so theirs start after a restart as before.
    if pushers is None:
        return

    endpoint = _endpoint(subscription)

    if any(pusher.subscription_info.get("endpoint") == endpoint for pusher in pushers):
        return

    try:
        pusher = WebPusher(dict(subscription))
    except (WebPushException, ValueError):
        logger.warning("Unable to push to a subscription of %s", username)
        return

    # a new list, since the sender may be iterating the old one
    client.web_pushers[username] = [*pushers, pusher]
    # a push service not seen before needs a signed claim of its own; this
    # has the next send sign them all again
    client.refresh = 0


def _remove_pushers(app: Any, detached: Mapping[str, Collection[str]]) -> None:
    client = _comm(app, "web_pushers")

    if client is None:
        return

    for username, endpoints in detached.items():
        pushers = client.web_pushers.get(username)

        if pushers is None:
            continue

        client.web_pushers[username] = [
            pusher
            for pusher in pushers
            if pusher.subscription_info.get("endpoint") not in endpoints
        ]


def link_push(
    app: Any, username: str, session_id: str, subscription: Mapping[str, Any]
) -> None:
    """Tie a subscription just registered to the session registering it."""
    endpoint = _endpoint(subscription)

    if endpoint is None:
        return

    _link(endpoint, username, session_id, time.time())
    _add_pusher(app, username, subscription)


def reattach_push(
    app: Any, username: str, session_id: str, subscription: Mapping[str, Any]
) -> bool:
    """Tie a device's subscription to the session it is signed in with now.

    It is the user's when it is in their tokens, or when one of their
    sessions ending detached it. Otherwise (never registered, or registered
    by someone else) it is left alone. Return whether it was tied.
    """
    endpoint = _endpoint(subscription)
    user = User.get_or_none(User.username == username)

    if endpoint is None or user is None:
        return False

    tokens = list(user.notification_tokens or [])

    if not any(_endpoint(token) == endpoint for token in tokens):
        table = _push_table()
        link = table.get_or_none(table.endpoint == endpoint)

        if link is None or link.username != username or link.session_id is not None:
            return False

        keys = subscription.get("keys") or {}
        tokens.append(
            {
                "endpoint": endpoint,
                "keys": {"p256dh": keys.get("p256dh"), "auth": keys.get("auth")},
            }
        )
        User.update(notification_tokens=tokens).where(
            User.username == username
        ).execute()
        logger.info("Restored a notification subscription of %s", username)

    _link(endpoint, username, session_id, time.time())
    _add_pusher(app, username, subscription)
    return True


def _detached_endpoints(
    session_ids: Collection[str], username: str | None, keep: str | None
) -> dict[str, set[str]]:
    """Return username -> endpoints that ended sessions take with them."""
    table = _push_table()
    detached: dict[str, set[str]] = {}

    if session_ids:
        for row in table.select(table.endpoint, table.username).where(
            table.session_id << list(session_ids)
        ):
            detached.setdefault(str(row.username), set()).add(str(row.endpoint))

    if username is None:
        return detached

    kept: set[str] = set()

    if keep is not None:
        kept = {
            str(row.endpoint)
            for row in table.select(table.endpoint).where(
                (table.username == username) & (table.session_id == keep)
            )
        }

    user = User.get_or_none(User.username == username)
    # every subscription of theirs, linked or registered before links existed
    endpoints = {
        str(row.endpoint)
        for row in table.select(table.endpoint).where(
            (table.username == username) & table.session_id.is_null(False)
        )
    }

    if user is not None:
        endpoints.update(
            endpoint
            for endpoint in map(_endpoint, user.notification_tokens or [])
            if endpoint is not None
        )

    detached.setdefault(username, set()).update(endpoints - kept)
    return detached


def detach_push(
    app: Any,
    session_ids: Collection[str],
    username: str | None = None,
    keep: str | None = None,
) -> int:
    """Stop pushing to the subscriptions of ended sessions; return how many.

    ``session_ids`` names the sessions. With ``username`` every subscription
    of that user goes but those of the session ``keep``, including ones whose
    session is not known. Raises on a table error.
    """
    detached = {
        user: endpoints
        for user, endpoints in _detached_endpoints(session_ids, username, keep).items()
        if endpoints
    }

    if not detached:
        return 0

    table = _push_table()
    now = time.time()

    for user, endpoints in detached.items():
        stored = User.get_or_none(User.username == user)

        if stored is None:
            # a deleted account: nothing to restore to later
            table.delete().where(table.username == user).execute()
            continue

        tokens = list(stored.notification_tokens or [])
        kept_tokens = [token for token in tokens if _endpoint(token) not in endpoints]

        if len(kept_tokens) != len(tokens):
            User.update(notification_tokens=kept_tokens).where(
                User.username == user
            ).execute()

        for endpoint in endpoints:
            _link(endpoint, user, None, now)

    _remove_pushers(app, detached)
    return sum(len(endpoints) for endpoints in detached.values())
