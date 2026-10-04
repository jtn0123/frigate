"""Signed-in sessions that can be listed and revoked (fork E26).

Every token issued at login carries a ``jti`` claim naming one row of the
session table, and a refresh re-signs the token with the same ``jti``, so a
session lasts from login until logout, expiry or revocation.

The ``/auth`` subrequest runs on every proxied request, HLS segments
included, so it never reads the table. It checks two things held in memory:
the ids of revoked sessions, and per user the time before which tokens are
refused (set by a password change or by deleting the account). Activity is
written back at most once a minute per session, by a worker thread. Frigate
serves the API from one process, so this memory is the only copy.

Tokens issued before this change have no ``jti``. They keep working until
they expire, and the first refresh gives them a session of their own.

When sessions end, frigate/fork/session_reach.py closes their open ``/ws``
connections and detaches their push subscriptions (fork E27).
"""

import logging
import queue
import secrets
import sqlite3
import threading
import time
import weakref
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any, cast

from fastapi import Request
from joserfc import jwt
from joserfc.errors import JoseError
from peewee import (
    CharField,
    FloatField,
    InterfaceError,
    Model,
    PeeweeException,
    fn,
)
from playhouse.sqliteq import SqliteQueueDatabase

from frigate.fork.session_reach import (
    close_session_sockets,
    cut_socket,
    detach_push,
    link_push,
    socket_session,
)
from frigate.models import User

logger = logging.getLogger(__name__)

# Activity is written to the table at most this often per session.
LAST_SEEN_WRITE_INTERVAL = 60.0
# After a failed load, the table is read again no sooner than this.
LOAD_RETRY_INTERVAL = 30.0
# A background write gives up waiting for Frigate's database queue after this.
WRITE_TIMEOUT = 5.0
# In-memory activity of a session idle this long is dropped; the table keeps it.
IDLE_FORGET_SECONDS = 86400.0
USER_AGENT_MAX_LENGTH = 512
IP_MAX_LENGTH = 64
SESSION_ID_BYTES = 16

DB_ERRORS = (PeeweeException, sqlite3.Error)


class UserSession(Model):
    """One login. The id is the ``jti`` claim of every token it was issued.

    The model is bound to whatever database ``User`` is bound to (see
    ``_table``), so the accounts and their sessions always share one file.
    """

    id = CharField(null=False, primary_key=True, max_length=64)
    username = CharField(index=True, max_length=30)
    created_at = FloatField()
    last_seen = FloatField()
    # the startup load and pruning filter on this
    expires_at = FloatField(index=True)
    user_agent = CharField(max_length=USER_AGENT_MAX_LENGTH, default="")
    ip = CharField(max_length=IP_MAX_LENGTH, default="")
    revoked_at = FloatField(null=True)


@dataclass(frozen=True)
class SessionInfo:
    """A session that is still usable, as the API lists it."""

    id: str
    username: str
    created_at: float
    last_seen: float
    expires_at: float
    user_agent: str
    ip: str


def _database_of(model: type[Model]) -> Any:
    # peewee keeps a model's binding on _meta and has no public getter
    return cast(Any, model)._meta.database


def _table() -> type[UserSession]:
    """Return the session model, bound to the accounts' database."""
    database = _database_of(User)

    if database is None:
        raise InterfaceError("The user table is not bound to a database")

    if _database_of(UserSession) is not database:
        UserSession.bind(database)

    return UserSession


def _int_claim(claims: Mapping[str, Any], name: str) -> int:
    try:
        return int(claims.get(name, 0))
    except (TypeError, ValueError):
        return 0


def _run_quietly(task: Callable[..., object], *args: Any) -> None:
    try:
        task(*args)
    except Exception:
        # background write: the next one retries, and the request that
        # queued it has already been answered
        logger.debug("Session table write failed", exc_info=True)


class _Writer:
    """One daemon thread that runs table writes in order.

    A daemon, so that a write stuck behind a stopped database queue never
    holds up the interpreter's exit. Shared by every store in the process.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queue: queue.SimpleQueue[
            tuple[Callable[..., object], tuple[Any, ...]]
        ] = queue.SimpleQueue()
        self._thread: threading.Thread | None = None

    def submit(self, task: Callable[..., object], *args: Any) -> None:
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._run, name="fork_sessions", daemon=True
                )
                self._thread.start()

        self._queue.put((task, args))

    def _run(self) -> None:
        while True:
            task, args = self._queue.get()
            _run_quietly(task, *args)

    def drain(self, timeout: float = 10.0) -> bool:
        """Wait until every write queued so far has run."""
        done = threading.Event()
        self.submit(done.set)
        return done.wait(timeout)


_writer = _Writer()


def _execute_bounded(query: Any) -> int:
    """Run a background write, waiting at most WRITE_TIMEOUT for the result.

    Frigate's queued database never answers once it is stopped, and a write
    that waited forever would stall every write queued after it.
    """
    database = _database_of(_table())
    sql, params = query.sql()

    if isinstance(database, SqliteQueueDatabase):
        cursor = database.execute_sql(sql, params, timeout=WRITE_TIMEOUT)
    else:
        cursor = database.execute_sql(sql, params)

    return int(cursor.rowcount)


def _write_last_seen(session_id: str, seen: float) -> None:
    table = _table()
    _execute_bounded(
        table.update(last_seen=seen).where(
            (table.id == session_id) & (table.last_seen < seen)
        )
    )


def _write_expiry(session_id: str, expires_at: float) -> None:
    table = _table()
    _execute_bounded(
        table.update(expires_at=expires_at).where(
            (table.id == session_id) & (table.expires_at < expires_at)
        )
    )


def _insert_query(
    session_id: str,
    username: str,
    now: float,
    expires_at: float,
    user_agent: str,
    ip: str,
) -> Any:
    return _table().insert(
        id=session_id,
        username=username,
        created_at=now,
        last_seen=now,
        expires_at=expires_at,
        user_agent=user_agent[:USER_AGENT_MAX_LENGTH],
        ip=ip[:IP_MAX_LENGTH],
    )


def _insert_later(
    session_id: str,
    username: str,
    now: float,
    expires_at: float,
    user_agent: str,
    ip: str,
) -> None:
    _execute_bounded(
        _insert_query(session_id, username, now, expires_at, user_agent, ip)
    )


def _prune_expired(now: float) -> None:
    """Delete sessions whose tokens have all expired, revoked or not."""
    table = _table()
    deleted = _execute_bounded(table.delete().where(table.expires_at < now))

    if deleted:
        logger.debug("Deleted %s expired sessions", deleted)


class SessionStore:
    """The in-memory side of the session table, one per API app."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._loaded = False
        self._retry_at = 0.0

        # session id -> expiry of a revoked session whose tokens may still be live
        self._revoked: dict[str, float] = {}
        # username -> unix second; tokens issued before it are refused
        self._not_before: dict[str, int] = {}
        # session id -> last activity, and the last activity written to the table
        self._seen: dict[str, float] = {}
        self._written: dict[str, float] = {}

    def _submit(self, task: Callable[..., object], *args: Any) -> None:
        _writer.submit(task, *args)

    def drain(self) -> bool:
        """Wait for the table writes queued so far; for tests."""
        return _writer.drain()

    def ensure_loaded(self, now: float) -> bool:
        """Read revoked sessions and password change times once.

        Until a read succeeds every token is judged on its signature and
        expiry alone, as before sessions existed. A failed read is retried
        after LOAD_RETRY_INTERVAL.
        """
        if self._loaded:
            return True

        if now < self._retry_at:
            return False

        return self._load_once(now)

    def _load_once(self, now: float) -> bool:
        with self._load_lock:
            # another request may have loaded while this one waited
            if self._loaded:
                return True

            try:
                table = _table()
                revoked = {
                    str(row.id): float(row.expires_at)
                    for row in table.select(table.id, table.expires_at).where(
                        table.revoked_at.is_null(False) & (table.expires_at > now)
                    )
                }
                changed = {
                    str(user.username): int(user.password_changed_at.timestamp())
                    for user in User.select(
                        User.username, User.password_changed_at
                    ).where(User.password_changed_at.is_null(False))
                }
            except DB_ERRORS:
                logger.warning(
                    "Unable to load signed-in sessions, retrying in %ss",
                    int(LOAD_RETRY_INTERVAL),
                )
                self._retry_at = now + LOAD_RETRY_INTERVAL
                return False

            with self._lock:
                # a revoke or password change made before the load stands
                for session_id, expires_at in revoked.items():
                    self._revoked.setdefault(session_id, expires_at)

                for username, changed_at in changed.items():
                    self._not_before[username] = max(
                        changed_at, self._not_before.get(username, 0)
                    )

                self._loaded = True

        self._submit(_prune_expired, now)
        return True

    def allows(self, claims: Mapping[str, Any], now: float) -> bool:
        """Return whether a validly signed, unexpired token may be used.

        Called from /auth on every request, so it only touches memory.
        """
        self.ensure_loaded(now)

        cutoff = self._not_before.get(str(claims.get("sub", "")))

        if cutoff is not None and _int_claim(claims, "iat") < cutoff:
            return False

        session_id = claims.get("jti")

        if not isinstance(session_id, str):
            # issued before sessions existed
            return True

        if session_id in self._revoked:
            return False

        self._touch(session_id, now)
        return True

    def _touch(self, session_id: str, now: float) -> None:
        with self._lock:
            self._seen[session_id] = now

            if now - self._written.get(session_id, 0.0) < LAST_SEEN_WRITE_INTERVAL:
                return

            self._written[session_id] = now

        self._submit(_write_last_seen, session_id, now)

    def _remember(self, session_id: str, now: float) -> None:
        with self._lock:
            self._seen[session_id] = now
            self._written[session_id] = now

            idle = [
                key
                for key, seen in self._seen.items()
                if now - seen > IDLE_FORGET_SECONDS
            ]

            for key in idle:
                self._seen.pop(key, None)
                self._written.pop(key, None)

    def create(
        self,
        username: str,
        expires_at: float,
        user_agent: str,
        ip: str,
        now: float,
    ) -> str:
        """Record a new session and return its id. Raises on a table error."""
        session_id = secrets.token_urlsafe(SESSION_ID_BYTES)
        self._remember(session_id, now)
        _insert_query(session_id, username, now, expires_at, user_agent, ip).execute()
        self._submit(_prune_expired, now)
        return session_id

    def refreshed(
        self, claims: Mapping[str, Any], expires_at: float, now: float
    ) -> str:
        """Return the session id a refreshed token carries.

        The refresh keeps the session; a token from before sessions existed
        gets a new one, with no user agent or address since the /auth
        subrequest carries neither.
        """
        session_id = claims.get("jti")

        if isinstance(session_id, str):
            self._submit(_write_expiry, session_id, expires_at)
            return session_id

        session_id = secrets.token_urlsafe(SESSION_ID_BYTES)
        self._remember(session_id, now)
        self._submit(
            _insert_later,
            session_id,
            str(claims.get("sub", "")),
            now,
            expires_at,
            "",
            "",
        )
        return session_id

    def get(self, session_id: str, now: float) -> SessionInfo | None:
        """Return a usable session by id. Raises on a table error."""
        table = _table()
        row = table.get_or_none(
            (table.id == session_id)
            & table.revoked_at.is_null()
            & (table.expires_at > now)
        )

        if row is None or session_id in self._revoked:
            return None

        return self._info(row)

    def list(self, now: float, username: str | None = None) -> list[SessionInfo]:
        """Return usable sessions, most recently active first."""
        table = _table()
        query = table.select().where(
            table.revoked_at.is_null() & (table.expires_at > now)
        )

        if username is not None:
            query = query.where(table.username == username)

        sessions = [
            self._info(row) for row in query if str(row.id) not in self._revoked
        ]
        sessions.sort(key=lambda session: session.last_seen, reverse=True)
        return sessions

    def _info(self, row: UserSession) -> SessionInfo:
        session_id = str(row.id)
        return SessionInfo(
            id=session_id,
            username=str(row.username),
            created_at=cast(float, row.created_at),
            # the table lags memory by up to LAST_SEEN_WRITE_INTERVAL
            last_seen=max(cast(float, row.last_seen), self._seen.get(session_id, 0.0)),
            expires_at=cast(float, row.expires_at),
            user_agent=str(row.user_agent or ""),
            ip=str(row.ip or ""),
        )

    def revoke(
        self, sessions: Mapping[str, float], now: float, session_length: float
    ) -> None:
        """Revoke sessions, given as id -> expiry. Raises on a table error.

        Memory is updated first, so the tokens stop working even if the
        write fails; only a restart would bring them back then.

        A refresh writes its new expiry from the writer thread, so the expiry
        read from the table can be a refresh behind. A revoked session is
        kept for at least ``session_length`` from now, the longest any of its
        tokens can still live, so it is not forgotten while one is valid.
        """
        if not sessions:
            return

        horizon = now + session_length
        revoked = {
            session_id: max(expires_at, horizon)
            for session_id, expires_at in sessions.items()
        }

        with self._lock:
            self._revoked = {
                session_id: expires_at
                for session_id, expires_at in self._revoked.items()
                if expires_at > now
            }
            self._revoked.update(revoked)

            for session_id in revoked:
                self._seen.pop(session_id, None)
                self._written.pop(session_id, None)

        # the row keeps the same expiry, so a restart reloads it and the
        # pruning leaves it until the last token has expired
        table = _table()
        table.update(
            revoked_at=now, expires_at=fn.MAX(table.expires_at, horizon)
        ).where((table.id << list(revoked)) & table.revoked_at.is_null()).execute()

    def revoke_user(
        self,
        username: str,
        now: float,
        session_length: float,
        keep: str | None = None,
    ) -> int:
        """Revoke every usable session of a user but ``keep``; return the count."""
        sessions = {
            session.id: session.expires_at
            for session in self.list(now, username)
            if session.id != keep
        }
        self.revoke(sessions, now, session_length)
        return len(sessions)

    def revoked(self, session_id: str) -> bool:
        """Return whether a session was revoked; memory only."""
        return session_id in self._revoked

    def refuse_issued_before(self, username: str, cutoff: int) -> None:
        """Refuse the user's tokens issued before ``cutoff``, sessions or not."""
        with self._lock:
            self._not_before[username] = max(cutoff, self._not_before.get(username, 0))


_store_lock = threading.Lock()
# every store of the process, for the /ws server, which has no app (E27)
_stores: "weakref.WeakSet[SessionStore]" = weakref.WeakSet()


def session_store(app: Any) -> SessionStore:
    """Return the app's session store, creating it on first use."""
    store: SessionStore | None = getattr(app.state, "fork_sessions", None)

    if store is not None:
        return store

    with _store_lock:
        store = getattr(app.state, "fork_sessions", None)

        if store is None:
            store = SessionStore()
            app.state.fork_sessions = store
            _stores.add(store)

    return store


def _request_token(request: Request) -> str | None:
    """Return the caller's JWT the way /auth finds it: header, then cookie."""
    header = request.headers.get("authorization", "")

    if header.startswith("Bearer "):
        return header.replace("Bearer ", "")

    return request.cookies.get(request.app.frigate_config.auth.cookie_name)


def _session_length(request: Request) -> float:
    return float(request.app.frigate_config.auth.session_length)


def current_session_id(request: Request, username: str | None = None) -> str | None:
    """Return the session id of the caller's own token, if it has one.

    With ``username``, only when the token is that user's.
    """
    key = getattr(request.app, "jwt_token", None)
    encoded = _request_token(request)

    if key is None or not encoded:
        return None

    try:
        token = jwt.decode(encoded, key)
    except (JoseError, ValueError):
        return None

    if username is not None and token.claims.get("sub") != username:
        return None

    return session_header(token.claims) or None


def session_header(claims: Mapping[str, Any]) -> str:
    """Return the session a token names, or "" (/auth's remote-session, E27)."""
    session_id = claims.get("jti")
    return session_id if isinstance(session_id, str) else ""


def session_revoked(session_id: str) -> bool:
    """Return whether a session of this process was revoked."""
    with _store_lock:
        stores = list(_stores)

    return any(store.revoked(session_id) for store in stores)


def socket_session_ended(ws: Any) -> bool:
    """Return whether a ``/ws`` connection belongs to an ended session (E27).

    A revoke closes its session's connections (see sessions_ended); one that
    was still opening then is cut here, at its first message. Neither takes
    another command.
    """
    if getattr(ws, "server_terminated", False):
        return True

    session_id = socket_session(ws)

    if session_id is None or not session_revoked(session_id):
        return False

    cut_socket(ws)
    return True


def sessions_ended(
    app: Any,
    session_ids: Collection[str],
    username: str | None = None,
    keep: str | None = None,
) -> None:
    """Cut what ended sessions still hold open: ``/ws`` and push (E27).

    ``session_ids`` names the sessions. With ``username``, all of that
    user's sessions ended but ``keep``. Call after the store has revoked
    them, so a closed connection cannot reconnect.
    """
    closed = close_session_sockets(app, session_ids, username, keep)

    try:
        detached = detach_push(app, session_ids, username, keep)
    except DB_ERRORS:
        logger.warning("Unable to detach the notifications of ended sessions")
        detached = 0

    if closed or detached:
        logger.debug(
            "Ended sessions lost %s connections and %s notifications",
            closed,
            detached,
        )


def link_registered_push(
    request: Request, username: str, subscription: Mapping[str, Any]
) -> None:
    """Tie a push subscription just registered to the caller's session (E27)."""
    session_id = current_session_id(request, username)

    if session_id is None:
        return

    try:
        link_push(request.app, username, session_id, subscription)
    except DB_ERRORS:
        logger.warning("Unable to link a notification subscription of %s", username)


# The functions below are what frigate/api/auth.py calls. A table error never
# fails a login, logout or password change; it is logged instead.


def session_allows(request: Request, claims: Mapping[str, Any], now: float) -> bool:
    """Return whether /auth may accept this token (see SessionStore.allows)."""
    return session_store(request.app).allows(claims, now)


def start_session(request: Request, username: str, expires_at: float, ip: str) -> str:
    """Record a login and return the session id its token carries."""
    store = session_store(request.app)
    store.ensure_loaded(time.time())
    user_agent = request.headers.get("user-agent", "")

    try:
        return store.create(username, expires_at, user_agent, ip, time.time())
    except DB_ERRORS:
        logger.warning("Unable to record a session for %s", username)
        # the token still names a session, so it can be revoked by id
        return secrets.token_urlsafe(SESSION_ID_BYTES)


def refresh_session(
    request: Request, claims: Mapping[str, Any], expires_at: float
) -> str:
    """Return the session id for a refreshed token."""
    return session_store(request.app).refreshed(claims, expires_at, time.time())


def role_changed(user: User, role: str, roles: Collection[str]) -> bool:
    """Return whether a token's role is no longer the account's role.

    A refresh copies the token's role, so without this a token from before a
    role change would carry the old role for as long as it kept refreshing.
    The account's role is resolved the way login resolves it: one missing
    from the config signs in as viewer.
    """
    current = user.role if user.role in roles else "viewer"
    return current != role


def end_current_session(request: Request) -> None:
    """Revoke the caller's own session, for logout."""
    key = getattr(request.app, "jwt_token", None)
    encoded = _request_token(request)

    if key is None or not encoded:
        return

    try:
        token = jwt.decode(encoded, key)
    except (JoseError, ValueError):
        return

    session_id = token.claims.get("jti")

    if not isinstance(session_id, str):
        return

    try:
        session_store(request.app).revoke(
            {session_id: float(_int_claim(token.claims, "exp"))},
            time.time(),
            _session_length(request),
        )
    except DB_ERRORS:
        logger.warning("Unable to record a logout; the session ends until restart")

    sessions_ended(request.app, {session_id})


def end_user_sessions(request: Request, username: str) -> None:
    """End all of a user's sessions, for a password, role or account change.

    Tokens issued before now are refused even without a session, which also
    covers tokens from before sessions existed. A password change is kept in
    ``User.password_changed_at``, so the cutoff survives a restart.
    """
    store = session_store(request.app)
    now = time.time()
    store.refuse_issued_before(username, int(now))

    try:
        revoked = store.revoke_user(username, now, _session_length(request))
    except DB_ERRORS:
        logger.warning("Unable to revoke the sessions of %s", username)
        revoked = 0

    if revoked:
        logger.info("Revoked %s sessions of %s", revoked, username)

    # the cutoff above refuses every token of the user, with a session or not
    sessions_ended(request.app, (), username)
