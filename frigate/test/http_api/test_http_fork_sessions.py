"""Signed-in sessions: login, refresh, logout, revocation and the API (fork E26)."""

import os
import time
from unittest.mock import MagicMock, Mock, patch

from fastapi import FastAPI
from fastapi.routing import APIRoute
from joserfc import jwt
from peewee import OperationalError

from frigate.api import fork_sessions
from frigate.api.auth import (
    assert_routes_have_auth_gate,
    create_encoded_jwt,
    hash_password,
)
from frigate.api.fastapi_app import create_fastapi_app
from frigate.config import FrigateConfig
from frigate.config.camera.updater import CameraConfigUpdatePublisher
from frigate.const import JWT_SECRET_ENV_VAR
from frigate.fork import sessions as sessions_module
from frigate.fork.sessions import (
    LAST_SEEN_WRITE_INTERVAL,
    SessionStore,
    UserSession,
    session_store,
)
from frigate.models import Event, Recordings, ReviewSegment, ShareLink, User
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_SECRET = "b" * 64
_PASSWORD = "correct-horse-battery"
_NEW_PASSWORD = "another-long-password"
_CHROME_MAC = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)
_SAFARI_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)


def _config() -> dict:
    return {
        "mqtt": {"host": "mqtt"},
        "auth": {"roles": {"garage": ["front_door"]}, "hash_iterations": 10},
        "networking": {"listen": {"internal": 5000, "external": 8971}},
        "cameras": {
            "front_door": {
                "ffmpeg": {
                    "inputs": [
                        {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                    ]
                },
                "detect": {"height": 1080, "width": 1920, "fps": 5},
            }
        },
    }


class _SessionsTestCase(BaseTestHttp):
    enforce_default_admin = False

    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, ShareLink, User, UserSession])
        env = patch.dict(os.environ, {JWT_SECRET_ENV_VAR: _SECRET})
        env.start()
        self.addCleanup(env.stop)
        self.publisher = Mock(spec=CameraConfigUpdatePublisher)
        self.publisher.publisher = MagicMock()
        self.app = create_fastapi_app(
            FrigateConfig(**_config()),
            self.db,
            None,
            None,
            None,
            None,
            None,
            None,
            self.publisher,
            None,
            enforce_default_admin=self.enforce_default_admin,
        )
        self.client = AuthTestClient(self.app)

        for username, role in (
            ("admin", "admin"),
            ("bob", "garage"),
            ("eve", "viewer"),
        ):
            User.insert(
                username=username,
                password_hash=hash_password(_PASSWORD, iterations=10),
                role=role,
                notification_tokens=[],
            ).execute()

    def tearDown(self):
        # queued activity writes must land before the database goes away
        session_store(self.app).drain()
        super().tearDown()

    def _login(self, user: str, user_agent: str = _CHROME_MAC) -> str:
        # a client of its own, so the cookie is not sent by later requests
        response = AuthTestClient(self.app).post(
            "/login",
            json={"user": user, "password": _PASSWORD},
            headers={"user-agent": user_agent, "x-forwarded-for": "203.0.113.7"},
        )
        self.assertEqual(response.status_code, 200)
        return response.cookies.get("frigate_token")

    def _legacy_token(self, user: str, role: str, exp_in: int, age: int = 0) -> str:
        """A token as issued before sessions existed: no jti claim."""
        now = int(time.time())
        claims = {"sub": user, "role": role, "exp": now + exp_in, "iat": now - age}
        return jwt.encode({"alg": "HS256"}, claims, self.app.jwt_token)

    def _claims(self, token: str) -> dict:
        return dict(jwt.decode(token, self.app.jwt_token).claims)

    def _auth(self, token: str, bearer: bool = False):
        headers = {"x-server-port": "8971"}

        if bearer:
            headers["authorization"] = f"Bearer {token}"
        else:
            headers["cookie"] = f"frigate_token={token}"

        return AuthTestClient(self.app).get("/auth", headers=headers)

    def _as(self, user: str, role: str, token: str | None = None) -> dict:
        headers = {"remote-user": user, "remote-role": role}

        if token is not None:
            headers["cookie"] = f"frigate_token={token}"

        return headers

    def _session(self, session_id: str) -> UserSession:
        session_store(self.app).drain()
        return UserSession.get_by_id(session_id)


class TestSessionLifecycle(_SessionsTestCase):
    def test_login_creates_a_session_named_by_the_token(self):
        token = self._login("bob")

        claims = self._claims(token)
        self.assertIn("jti", claims)
        row = self._session(claims["jti"])
        self.assertEqual(row.username, "bob")
        self.assertEqual(row.user_agent, _CHROME_MAC)
        self.assertEqual(row.ip, "203.0.113.7")
        self.assertEqual(row.expires_at, claims["exp"])
        self.assertIsNone(row.revoked_at)
        self.assertEqual(self._auth(token).status_code, 202)

    def test_refresh_keeps_the_session(self):
        jti = self._claims(self._login("bob"))["jti"]
        expiring = create_encoded_jwt(
            "bob", "garage", int(time.time()) + 60, self.app.jwt_token, jti=jti
        )

        response = self._auth(expiring)

        self.assertEqual(response.status_code, 202)
        refreshed = self._claims(response.cookies.get("frigate_token"))
        self.assertEqual(refreshed["jti"], jti)
        self.assertGreater(refreshed["exp"], int(time.time()) + 80000)
        self.assertEqual(self._session(jti).expires_at, refreshed["exp"])

    def test_revoked_session_is_refused_by_auth(self):
        token = self._login("bob")
        jti = self._claims(token)["jti"]

        response = self.client.delete(
            f"/fork/sessions/{jti}", headers=self._as("admin", "admin")
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._auth(token).status_code, 401)
        self.assertEqual(self._auth(token, bearer=True).status_code, 401)
        self.assertIsNotNone(self._session(jti).revoked_at)

    def test_revocation_survives_a_restart(self):
        token = self._login("bob")
        jti = self._claims(token)["jti"]
        self.client.delete(f"/fork/sessions/{jti}", headers=self._as("admin", "admin"))

        # a fresh store reads the revoked ids back from the table
        self.app.state.fork_sessions = SessionStore()

        self.assertEqual(self._auth(token).status_code, 401)

    def test_logout_revokes_the_session(self):
        token = self._login("bob")
        other = self._login("bob", _SAFARI_IPHONE)

        response = self.client.get(
            "/logout",
            headers={"cookie": f"frigate_token={token}"},
            follow_redirects=False,
        )

        self.assertEqual(response.status_code, 303)
        self.assertEqual(self._auth(token).status_code, 401)
        # only the session that logged out ends
        self.assertEqual(self._auth(other).status_code, 202)

    def test_own_password_change_ends_every_session_but_issues_a_new_one(self):
        first = self._login("bob")
        second = self._login("bob", _SAFARI_IPHONE)

        response = self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD, "old_password": _PASSWORD},
            headers=self._as("bob", "garage", first),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._auth(first).status_code, 401)
        self.assertEqual(self._auth(second).status_code, 401)
        replacement = response.cookies.get("frigate_token")
        self.assertEqual(self._auth(replacement).status_code, 202)
        new_jti = self._claims(replacement)["jti"]
        self.assertNotIn(new_jti, {self._claims(t)["jti"] for t in (first, second)})
        self.assertIsNone(self._session(new_jti).revoked_at)

    def test_admin_password_reset_ends_the_users_sessions(self):
        token = self._login("bob")
        admin = self._login("admin")

        response = self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD},
            headers=self._as("admin", "admin", admin),
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self._auth(token).status_code, 401)
        self.assertEqual(self._auth(admin).status_code, 202)

    def test_deleting_a_user_ends_their_sessions(self):
        token = self._login("bob")

        response = self.client.delete("/users/bob", headers=self._as("admin", "admin"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._auth(token).status_code, 401)

    def test_role_change_ends_the_users_sessions(self):
        token = self._login("bob")
        legacy = self._legacy_token("bob", "garage", 3600, age=60)
        other = self._login("eve")

        response = self.client.put(
            "/users/bob/role",
            json={"role": "viewer"},
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(response.status_code, 200)
        # the old tokens carry the old role, so they stop working now
        self.assertEqual(self._auth(token).status_code, 401)
        self.assertEqual(self._auth(legacy).status_code, 401)
        self.assertEqual(self._auth(other).status_code, 202)
        # signing in again gives a token with the new role
        replacement = self._auth(self._login("bob"))
        self.assertEqual(replacement.status_code, 202)
        self.assertEqual(replacement.headers["remote-role"], "viewer")

    def test_refresh_refuses_a_token_from_before_a_role_change(self):
        # a role changed while the cutoff was not in memory (after a restart)
        legacy = self._legacy_token("bob", "garage", 60)
        User.update(role="viewer").where(User.username == "bob").execute()

        response = self._auth(legacy)

        self.assertEqual(response.status_code, 401)
        self.assertNotIn("set-cookie", response.headers)

    def test_refresh_keeps_a_role_missing_from_the_config_as_viewer(self):
        # login signs a role the config lacks in as viewer; refresh agrees
        User.update(role="retired").where(User.username == "bob").execute()
        jti = self._claims(self._login("bob"))["jti"]
        expiring = create_encoded_jwt(
            "bob", "viewer", int(time.time()) + 60, self.app.jwt_token, jti=jti
        )

        response = self._auth(expiring)

        self.assertEqual(response.status_code, 202)
        self.assertIn("frigate_token", response.cookies)

    def test_token_without_a_session_is_still_accepted(self):
        legacy = self._legacy_token("bob", "garage", 3600)

        response = self._auth(legacy)

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-user"], "bob")

    def test_token_without_a_session_gets_one_at_refresh(self):
        legacy = self._legacy_token("bob", "garage", 60)

        response = self._auth(legacy)

        self.assertEqual(response.status_code, 202)
        refreshed = self._claims(response.cookies.get("frigate_token"))
        row = self._session(refreshed["jti"])
        self.assertEqual(row.username, "bob")
        self.assertEqual(row.user_agent, "")

    def test_token_without_a_session_ends_with_a_password_change(self):
        legacy = self._legacy_token("bob", "garage", 3600, age=60)
        self.assertEqual(self._auth(legacy).status_code, 202)

        self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD},
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(self._auth(legacy).status_code, 401)

    def test_token_from_before_a_password_change_is_refused_after_restart(self):
        legacy = self._legacy_token("bob", "garage", 3600, age=60)
        self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD},
            headers=self._as("admin", "admin"),
        )

        # the cutoff is read back from User.password_changed_at
        self.app.state.fork_sessions = SessionStore()

        self.assertEqual(self._auth(legacy).status_code, 401)


class TestActivity(_SessionsTestCase):
    def test_last_seen_is_written_at_most_once_a_minute(self):
        store = SessionStore()
        store.ensure_loaded(time.time())
        jti = store.create("bob", time.time() + 3600, _CHROME_MAC, "10.0.0.5", 1000.0)
        claims = {"sub": "bob", "jti": jti, "iat": 1000}

        with patch.object(sessions_module._writer, "submit") as submit:
            self.assertTrue(store.allows(claims, 1010.0))
            self.assertTrue(store.allows(claims, 1030.0))
            submit.assert_not_called()

            self.assertTrue(store.allows(claims, 1000.0 + LAST_SEEN_WRITE_INTERVAL))
            submit.assert_called_once_with(
                sessions_module._write_last_seen,
                jti,
                1000.0 + LAST_SEEN_WRITE_INTERVAL,
            )

        # the list reports activity that is not written yet
        listed = store.list(1100.0, "bob")
        self.assertEqual(listed[0].last_seen, 1000.0 + LAST_SEEN_WRITE_INTERVAL)

    def test_revoke_just_after_a_refresh_outlives_the_old_expiry(self):
        store = SessionStore()
        store.ensure_loaded(1000.0)
        jti = store.create("bob", 1060.0, _CHROME_MAC, "10.0.0.5", 1000.0)
        session_length = 86400.0
        refreshed_until = 1030.0 + session_length

        # the refresh's expiry write is still queued when the revoke reads
        # the row, so the revoke sees the expiry from before the refresh
        with patch.object(sessions_module._writer, "submit"):
            self.assertEqual(
                store.refreshed({"sub": "bob", "jti": jti}, refreshed_until, 1030.0),
                jti,
            )
        stale = store.get(jti, 1031.0)
        self.assertEqual(stale.expires_at, 1060.0)
        store.revoke({jti: stale.expires_at}, 1031.0, session_length)

        # a later revoke forgets entries whose recorded expiry has passed
        other = store.create("bob", 5000.0, _CHROME_MAC, "10.0.0.5", 1100.0)
        store.revoke({other: 5000.0}, 2000.0, session_length)

        claims = {"sub": "bob", "jti": jti, "iat": 1030}
        self.assertFalse(store.allows(claims, 2000.0))
        # the row keeps the longer expiry, so a restart reloads it too
        self.assertEqual(UserSession.get_by_id(jti).expires_at, 1031.0 + session_length)
        restarted = SessionStore()
        restarted.ensure_loaded(2000.0)
        self.assertFalse(restarted.allows(claims, 2000.0))

    def test_activity_is_written_in_the_background(self):
        token = self._login("bob")
        jti = self._claims(token)["jti"]
        store = session_store(self.app)
        later = time.time() + LAST_SEEN_WRITE_INTERVAL + 1

        self.assertTrue(store.allows(self._claims(token), later))

        self.assertEqual(self._session(jti).last_seen, later)

    def test_an_unreadable_table_leaves_tokens_working(self):
        store = SessionStore()

        with (
            patch.object(
                sessions_module, "_table", side_effect=OperationalError("no table")
            ),
            self.assertLogs("frigate.fork.sessions", level="WARNING"),
        ):
            self.assertFalse(store.ensure_loaded(1000.0))

        # retried only after the wait
        self.assertFalse(store.ensure_loaded(1001.0))
        self.assertTrue(store.allows({"sub": "bob", "jti": "x", "iat": 1}, 1002.0))
        self.assertTrue(store.ensure_loaded(1100.0))


class TestSessionsApi(_SessionsTestCase):
    def test_admin_lists_everyone_and_sees_which_is_theirs(self):
        admin = self._login("admin")
        self._login("bob", _SAFARI_IPHONE)

        response = self.client.get(
            "/fork/sessions", headers=self._as("admin", "admin", admin)
        )

        self.assertEqual(response.status_code, 200)
        rows = response.json()
        self.assertEqual({row["username"] for row in rows}, {"admin", "bob"})
        current = [row for row in rows if row["current"]]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]["id"], self._claims(admin)["jti"])
        bob = next(row for row in rows if row["username"] == "bob")
        self.assertEqual(bob["user_agent"], _SAFARI_IPHONE)
        self.assertEqual(bob["ip"], "203.0.113.7")

    def test_list_is_never_cached(self):
        admin = self._login("admin")

        response = self.client.get(
            "/fork/sessions", headers=self._as("admin", "admin", admin)
        )

        # nginx's API cache is keyed by user, not session; no-store keeps one
        # session from being served another's `current` flag
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response.headers.get("cache-control", ""))

    def test_user_lists_only_their_own(self):
        self._login("admin")
        bob = self._login("bob")

        rows = self.client.get(
            "/fork/sessions", headers=self._as("bob", "garage", bob)
        ).json()

        self.assertEqual([row["username"] for row in rows], ["bob"])
        self.assertTrue(rows[0]["current"])

    def test_revoked_and_expired_sessions_are_not_listed(self):
        bob = self._login("bob")
        self._login("bob")
        jti = self._claims(bob)["jti"]
        self.client.delete(f"/fork/sessions/{jti}", headers=self._as("bob", "garage"))
        UserSession.insert(
            id="expired",
            username="bob",
            created_at=1.0,
            last_seen=1.0,
            expires_at=2.0,
        ).execute()

        rows = self.client.get(
            "/fork/sessions", headers=self._as("bob", "garage")
        ).json()

        self.assertEqual(len(rows), 1)
        self.assertNotIn(rows[0]["id"], {jti, "expired"})

    def test_user_cannot_revoke_someone_elses_session(self):
        admin = self._login("admin")
        jti = self._claims(admin)["jti"]

        response = self.client.delete(
            f"/fork/sessions/{jti}", headers=self._as("bob", "garage")
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(self._auth(admin).status_code, 202)

    def test_user_revokes_their_own_session(self):
        phone = self._login("bob", _SAFARI_IPHONE)
        laptop = self._login("bob")

        response = self.client.delete(
            f"/fork/sessions/{self._claims(phone)['jti']}",
            headers=self._as("bob", "garage", laptop),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._auth(phone).status_code, 401)
        self.assertEqual(self._auth(laptop).status_code, 202)

    def test_unknown_session_is_404(self):
        response = self.client.delete(
            "/fork/sessions/nope", headers=self._as("admin", "admin")
        )

        self.assertEqual(response.status_code, 404)

    def test_user_cannot_sign_out_someone_else(self):
        admin = self._login("admin")

        response = self.client.post(
            "/fork/sessions/revoke_all",
            json={"username": "admin"},
            headers=self._as("bob", "garage"),
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self._auth(admin).status_code, 202)

    def test_sign_out_other_sessions_keeps_the_callers(self):
        laptop = self._login("bob")
        phone = self._login("bob", _SAFARI_IPHONE)
        tablet = self._login("bob")

        response = self.client.post(
            "/fork/sessions/revoke_all",
            json={"keep_current": True},
            headers=self._as("bob", "garage", laptop),
        )

        self.assertEqual(response.json(), {"success": True, "revoked": 2})
        self.assertEqual(self._auth(laptop).status_code, 202)
        self.assertEqual(self._auth(phone).status_code, 401)
        self.assertEqual(self._auth(tablet).status_code, 401)

    def test_admin_signs_a_user_out_everywhere(self):
        bob = [self._login("bob"), self._login("bob", _SAFARI_IPHONE)]
        eve = self._login("eve")

        response = self.client.post(
            "/fork/sessions/revoke_all",
            json={"username": "bob"},
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(response.json(), {"success": True, "revoked": 2})
        self.assertEqual([self._auth(t).status_code for t in bob], [401, 401])
        self.assertEqual(self._auth(eve).status_code, 202)

    def test_signing_out_everywhere_refuses_a_token_without_a_session(self):
        legacy = self._legacy_token("bob", "viewer", 3600, age=5)

        self.client.post(
            "/fork/sessions/revoke_all",
            json={"username": "bob"},
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(self._auth(legacy).status_code, 401)
        self.assertEqual(self._auth(self._login("bob")).status_code, 202)

    def test_signing_out_other_sessions_keeps_a_token_without_a_session(self):
        legacy = self._legacy_token("bob", "viewer", 3600, age=5)
        mine = self._login("bob")

        self.client.post(
            "/fork/sessions/revoke_all",
            json={"keep_current": True},
            headers=self._as("bob", "viewer", mine),
        )

        # the cutoff would end the caller's own session too
        self.assertEqual(self._auth(mine).status_code, 202)
        self.assertEqual(self._auth(legacy).status_code, 202)

    def test_internal_port_lists_without_a_current_session(self):
        self._login("bob")

        rows = self.client.get(
            "/fork/sessions", headers=self._as("anonymous", "admin")
        ).json()

        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["current"])


class TestSessionsAccess(_SessionsTestCase):
    # the global admin default is on, as in the running app
    enforce_default_admin = True

    def test_non_admin_reaches_the_session_routes(self):
        bob = self._login("bob")
        headers = self._as("bob", "garage", bob)

        listed = self.client.get("/fork/sessions", headers=headers)
        revoked = self.client.delete("/fork/sessions/nope", headers=headers)
        signed_out = self.client.post(
            "/fork/sessions/revoke_all", json={"keep_current": True}, headers=headers
        )

        self.assertEqual(listed.status_code, 200)
        self.assertEqual(revoked.status_code, 404)
        self.assertEqual(signed_out.status_code, 200)

    def test_anonymous_is_refused(self):
        response = self.client.get(
            "/fork/sessions", headers={"remote-user": "", "remote-role": ""}
        )

        self.assertEqual(response.status_code, 401)

    def test_every_session_route_has_one_auth_gate(self):
        app = FastAPI()
        app.include_router(fork_sessions.router)

        assert_routes_have_auth_gate(app)
        paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
        self.assertEqual(
            paths,
            {
                "/fork/sessions",
                "/fork/sessions/{session_id}",
                "/fork/sessions/revoke_all",
            },
        )
