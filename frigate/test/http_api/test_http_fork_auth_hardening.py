"""Session hardening ported from upstream #24713 onto the fork's E26 sessions (E33)."""

import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

from frigate.api.auth import create_encoded_jwt
from frigate.app import FrigateApp
from frigate.config import FrigateConfig
from frigate.fork.sessions import SessionStore
from frigate.models import User
from frigate.test.http_api.test_http_fork_sessions import (
    _NEW_PASSWORD,
    _PASSWORD,
    _config,
    _SessionsTestCase,
)


class TestSecureCookie(_SessionsTestCase):
    def _login_cookie(self, headers: dict[str, str] | None = None) -> str:
        response = self.client.post(
            "/login",
            json={"user": "bob", "password": _PASSWORD},
            headers=headers or {},
        )

        self.assertEqual(response.status_code, 200)
        return response.headers["set-cookie"].lower()

    def test_login_cookie_is_secure_over_tls(self):
        self.assertIn("; secure", self._login_cookie({"x-forwarded-proto": "https"}))

    def test_login_cookie_is_not_secure_over_http(self):
        cookie = self._login_cookie({"x-forwarded-proto": "http"})

        self.assertNotIn("; secure", cookie)

    def test_cookie_secure_config_forces_secure(self):
        self.app.frigate_config.auth.cookie_secure = True

        self.assertIn("; secure", self._login_cookie())

    def test_refreshed_cookie_is_secure_over_tls(self):
        jti = self._claims(self._login("bob"))["jti"]
        expiring = self._expiring_token(jti)

        response = self.client.get(
            "/auth",
            headers={
                "x-server-port": "8971",
                "x-forwarded-proto": "https",
                "cookie": f"frigate_token={expiring}",
            },
        )

        self.assertEqual(response.status_code, 202)
        self.assertIn("; secure", response.headers["set-cookie"].lower())

    def test_own_password_change_cookie_is_secure_over_tls(self):
        token = self._login("bob")

        response = self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD, "old_password": _PASSWORD},
            headers={**self._as("bob", "garage", token), "x-forwarded-proto": "https"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("; secure", response.headers["set-cookie"].lower())

    def _expiring_token(self, jti: str) -> str:
        return create_encoded_jwt(
            "bob", "garage", int(time.time()) + 60, self.app.jwt_token, jti=jti
        )


class TestRoleMissingFromConfig(_SessionsTestCase):
    def test_login_is_refused(self):
        # falling back to viewer would open every camera to a restricted user
        User.update(role="retired").where(User.username == "bob").execute()

        response = self.client.post(
            "/login", json={"user": "bob", "password": _PASSWORD}
        )

        self.assertEqual(response.status_code, 401)
        self.assertNotIn("set-cookie", response.headers)


class TestSameSecondRevocation(_SessionsTestCase):
    def test_token_from_the_same_second_as_a_password_change_is_refused(self):
        # upstream floors both times and leaves this window open; the fork
        # also revokes the token's session, so the second does not matter
        second = int(time.time())

        with patch("time.time", return_value=second + 0.2):
            token = self._login("bob")

        with patch("time.time", return_value=second + 0.7):
            response = self.client.put(
                "/users/bob/password",
                json={"password": _NEW_PASSWORD},
                headers=self._as("admin", "admin"),
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._auth(token).status_code, 401)


class TestStartupAdminPasswordReset(_SessionsTestCase):
    def _reset_admin_password_at_startup(self) -> None:
        config = _config()
        config["auth"]["reset_admin_password"] = True

        with (
            tempfile.TemporaryDirectory() as directory,
            patch("frigate.app.CONFIG_DIR", directory),
        ):
            FrigateApp.init_auth(SimpleNamespace(config=FrigateConfig(**config)))

        # the reset runs at startup, so the API starts with a fresh store
        self.app.state.fork_sessions = SessionStore()

    def test_reset_refuses_the_admins_older_tokens(self):
        # signed in a minute before the restart
        with patch("time.time", return_value=time.time() - 60):
            token = self._login("admin")
        legacy = self._legacy_token("admin", "admin", 3600, age=60)
        self.assertEqual(self._auth(token).status_code, 202)

        self._reset_admin_password_at_startup()

        self.assertEqual(self._auth(token).status_code, 401)
        self.assertEqual(self._auth(legacy).status_code, 401)
        self.assertIsNotNone(User.get_by_id("admin").password_changed_at)

    def test_reset_leaves_other_users_signed_in(self):
        with patch("time.time", return_value=time.time() - 60):
            token = self._login("bob")

        self._reset_admin_password_at_startup()

        self.assertEqual(self._auth(token).status_code, 202)
