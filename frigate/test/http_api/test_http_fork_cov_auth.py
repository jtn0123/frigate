"""HTTP and helper tests for the auth endpoints and gates (fork D70)."""

import asyncio
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, mock_open, patch

from fastapi import HTTPException, Response
from joserfc import jwt
from joserfc.jwk import OctKey

from frigate.api import auth as auth_api
from frigate.api.auth import (
    RateLimiter,
    allow_any_authenticated,
    create_encoded_jwt,
    deny_response_for_go2rtc_stream,
    get_allowed_cameras_for_filter,
    get_jwt_secret,
    get_remote_addr,
    hash_password,
    require_admin_by_default,
    require_camera_access,
    require_full_camera_access,
    require_go2rtc_stream_access,
    require_role,
    resolve_role,
    set_jwt_cookie,
    validate_password_strength,
    verify_password,
)
from frigate.api.fastapi_app import create_fastapi_app
from frigate.config import FrigateConfig
from frigate.config.camera.updater import CameraConfigUpdatePublisher
from frigate.const import JWT_SECRET_ENV_VAR
from frigate.models import Event, Recordings, ReviewSegment, ShareLink, User
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_SECRET = "a" * 64
_PASSWORD = "correct-horse-battery"
_DOCKER_SECRET = os.path.join("/run/secrets", JWT_SECRET_ENV_VAR)
_OPTIONS_FILE = "/data/options.json"


def _camera(path: str) -> dict:
    return {
        "ffmpeg": {"inputs": [{"path": path, "roles": ["detect"]}]},
        "detect": {"height": 1080, "width": 1920, "fps": 5},
    }


def _config_dict(**auth) -> dict:
    front = _camera("rtsp://10.0.0.1:554/video")
    front["live"] = {"streams": {"Sub": "front_sub"}}

    return {
        "mqtt": {"host": "mqtt"},
        "auth": {
            "roles": {"garage": ["front_door"]},
            "hash_iterations": 10,
            **auth,
        },
        "go2rtc": {"streams": {"front_sub": ["rtsp://10.0.0.1:554/sub"]}},
        "cameras": {
            "front_door": front,
            "back_yard": _camera("rtsp://10.0.0.2:554/video"),
        },
    }


def _request(headers=None, app_config=None, host="10.0.0.9", path="/"):
    """A minimal stand in for a starlette request."""
    return SimpleNamespace(
        headers=headers or {},
        client=SimpleNamespace(host=host) if host else None,
        url=SimpleNamespace(path=path),
        app=SimpleNamespace(frigate_config=app_config),
    )


def _run(coro):
    return asyncio.run(coro)


class TestPasswordHelpers(unittest.TestCase):
    def test_hash_round_trip(self):
        hashed = hash_password("hunter2hunter2", salt="pepper", iterations=5)

        self.assertTrue(hashed.startswith("pbkdf2_sha256$5$pepper$"))
        self.assertTrue(verify_password("hunter2hunter2", hashed))
        self.assertFalse(verify_password("hunter3hunter3", hashed))

    def test_random_salts_differ(self):
        first = hash_password("same-password", iterations=5)
        second = hash_password("same-password", iterations=5)

        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("same-password", first))

    def test_malformed_hashes_never_verify(self):
        for value in (None, "", "plain", "a$b", "a$b$c$d$e"):
            with self.subTest(value=value):
                self.assertFalse(verify_password("x", value))

    def test_salt_with_a_separator_is_refused(self):
        with self.assertRaises(AssertionError):
            hash_password("password", salt="bad$salt", iterations=5)

    def test_password_strength(self):
        self.assertEqual(
            validate_password_strength(""), (False, "Password cannot be empty")
        )
        self.assertEqual(
            validate_password_strength("short"),
            (False, "Password must be at least 12 characters long"),
        )
        self.assertEqual(validate_password_strength("x" * 12), (True, None))


class TestJwtHelpers(unittest.TestCase):
    def test_encoded_jwt_carries_the_claims(self):
        key = OctKey.import_key(_SECRET.encode())
        before = int(time.time())

        token = create_encoded_jwt("bob", "garage", 1234, key)
        claims = jwt.decode(token, key).claims

        self.assertEqual(claims["sub"], "bob")
        self.assertEqual(claims["role"], "garage")
        self.assertEqual(claims["exp"], 1234)
        self.assertGreaterEqual(claims["iat"], before)

    def test_cookie_flags(self):
        response = Response()

        set_jwt_cookie(response, "frigate_token", "abc", 60, True)

        cookie = response.headers["set-cookie"]
        self.assertIn("frigate_token=abc", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Max-Age=60", cookie)
        self.assertIn("Secure", cookie)
        # Starlette always writes SameSite=lax, so it is never truly unset
        self.assertIn("SameSite=lax", cookie)

    def test_rate_limiter_holds_its_limit(self):
        limiter = RateLimiter()

        self.assertEqual(limiter.get_limit(), "")
        limiter.set_limit("5/minute")
        self.assertEqual(limiter.get_limit(), "5/minute")


class TestJwtSecret(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(JWT_SECRET_ENV_VAR, None)

        self.config_dir = tempfile.mkdtemp()
        config_patch = patch("frigate.api.auth.CONFIG_DIR", self.config_dir)
        config_patch.start()
        self.addCleanup(config_patch.stop)
        self.present: set[str] = set()
        real_isfile = os.path.isfile

        def fake_isfile(path):
            if path in (_DOCKER_SECRET, _OPTIONS_FILE):
                return path in self.present
            return real_isfile(path)

        isfile_patch = patch("frigate.api.auth.os.path.isfile", fake_isfile)
        isfile_patch.start()
        self.addCleanup(isfile_patch.stop)

    def tearDown(self):
        for name in os.listdir(self.config_dir):
            os.remove(os.path.join(self.config_dir, name))
        os.rmdir(self.config_dir)

    def test_environment_variable_wins(self):
        os.environ[JWT_SECRET_ENV_VAR] = "short"

        with self.assertLogs("frigate.api.auth", level="WARNING") as logs:
            secret = get_jwt_secret()

        self.assertEqual(secret, "short")
        self.assertIn("64 characters", logs.output[0])

    def test_docker_secret_file(self):
        self.present.add(_DOCKER_SECRET)

        with patch("frigate.api.auth.Path") as path_cls:
            path_cls.return_value.read_text.return_value = f"  {_SECRET}\n"
            secret = get_jwt_secret()

        self.assertEqual(secret, _SECRET)
        path_cls.assert_called_once_with(_DOCKER_SECRET)

    def test_home_assistant_options_file(self):
        self.present.add(_OPTIONS_FILE)
        options = json.dumps({"jwt_secret": _SECRET})

        with patch("frigate.api.auth.open", mock_open(read_data=options), create=True):
            secret = get_jwt_secret()

        self.assertEqual(secret, _SECRET)

    def test_options_file_without_a_secret_falls_back_to_generation(self):
        self.present.add(_OPTIONS_FILE)

        with patch("frigate.api.auth.open", mock_open(read_data="{}"), create=True):
            with patch("frigate.api.auth.os.open", side_effect=OSError("ro")):
                with self.assertLogs("frigate.api.auth", level="WARNING") as logs:
                    secret = get_jwt_secret()

        self.assertEqual(len(secret), 128)
        self.assertIn("Unable to write jwt token file", logs.output[0])

    def test_generated_secret_is_stored_and_reused(self):
        first = get_jwt_secret()
        stored = os.path.join(self.config_dir, ".jwt_secret")

        self.assertEqual(len(first), 128)
        self.assertTrue(os.path.isfile(stored))
        self.assertEqual(os.stat(stored).st_mode & 0o777, 0o600)
        self.assertEqual(get_jwt_secret(), first)


class TestRemoteAddr(unittest.TestCase):
    def _config(self, proxies):
        return SimpleNamespace(auth=SimpleNamespace(trusted_proxies=proxies))

    def test_direct_peer_without_forwarding(self):
        self.assertEqual(get_remote_addr(_request(host="10.1.1.1")), "10.1.1.1")
        self.assertEqual(get_remote_addr(_request(host=None)), "127.0.0.1")

    def test_first_untrusted_hop_from_the_right(self):
        request = _request(
            headers={"x-forwarded-for": "1.2.3.4, 10.0.0.5, 172.16.0.2"},
            app_config=self._config(["172.16.0.0/12", "10.0.0.0/8"]),
        )

        self.assertEqual(get_remote_addr(request), "1.2.3.4")

    def test_no_trusted_proxies_returns_the_last_hop(self):
        request = _request(
            headers={"x-forwarded-for": "1.2.3.4, 5.6.7.8"},
            app_config=self._config([]),
        )

        self.assertEqual(get_remote_addr(request), "5.6.7.8")

    def test_every_hop_trusted_falls_back_to_the_peer(self):
        request = _request(
            headers={"x-forwarded-for": "10.0.0.1, 10.0.0.2"},
            app_config=self._config(["10.0.0.0/8"]),
            host="192.168.1.2",
        )

        self.assertEqual(get_remote_addr(request), "192.168.1.2")

        request.client = None
        self.assertEqual(get_remote_addr(request), "127.0.0.1")

    def test_ipv4_mapped_and_native_ipv6_hops(self):
        request = _request(
            headers={"x-forwarded-for": "2001:db8::99, ::ffff:10.0.0.7, fd00::1"},
            app_config=self._config(["10.0.0.0/8", "fd00::/8"]),
        )

        self.assertEqual(get_remote_addr(request), "2001:db8::99")


class TestRoleGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = FrigateConfig(**_config_dict())

    def _role(self, header, required):
        checker = require_role(required)
        return _run(checker(_request({"remote-role": header}, self.config)))

    def test_require_role_accepts_a_matching_role(self):
        self.assertEqual(self._role("admin", ["admin"]), "admin")
        self.assertEqual(self._role("bogus,garage", ["garage", "admin"]), "garage")

    def test_require_role_rejections(self):
        for header, detail in (
            (None, "Role not provided"),
            ("bogus", "No valid roles found"),
            ("viewer", "Role viewer not authorized"),
        ):
            with self.subTest(header=header):
                with self.assertRaises(HTTPException) as ctx:
                    self._role(header, ["admin"])
                self.assertEqual(ctx.exception.status_code, 403)
                self.assertIn(detail, ctx.exception.detail)

    def test_allow_any_authenticated(self):
        checker = allow_any_authenticated()

        self.assertIsNone(_run(checker(_request({"remote-role": "admin"}))))
        self.assertIsNone(
            _run(checker(_request({"remote-user": "bob", "remote-role": "viewer"})))
        )

        for headers in ({}, {"remote-user": "anonymous", "remote-role": "viewer"}):
            with self.subTest(headers=headers):
                with self.assertRaises(HTTPException) as ctx:
                    _run(checker(_request(headers)))
                self.assertEqual(ctx.exception.status_code, 401)

    def test_admin_by_default_exemptions(self):
        checker = require_admin_by_default()
        viewer = {"remote-role": "viewer"}

        for path in ("/login", "/review/abc", "/front_door/latest.jpg"):
            with self.subTest(path=path):
                request = _request(viewer, self.config, path=path)
                self.assertIsNone(_run(checker(request)))

        admin = _request({"remote-role": "admin"}, self.config, path="/config/set")
        self.assertIsNone(_run(checker(admin)))

        with self.assertRaises(HTTPException) as ctx:
            _run(checker(_request(viewer, self.config, path="/config/set")))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_admin_by_default_fails_closed_without_a_config(self):
        checker = require_admin_by_default()
        request = _request({"remote-role": "viewer"}, path="/front_door/x")
        request.app = SimpleNamespace()

        with self.assertRaises(HTTPException):
            _run(checker(request))

    def test_resolve_role_without_a_role_header(self):
        proxy = FrigateConfig(**_config_dict()).proxy
        proxy.default_role = "garage"

        self.assertEqual(resolve_role({}, proxy, {"admin", "garage"}), "garage")
        self.assertEqual(resolve_role({}, proxy, set()), "viewer")
        self.assertEqual(resolve_role({}, proxy, {"admin"}), "viewer")

    def test_resolve_role_from_mapped_groups(self):
        proxy = FrigateConfig(**_config_dict()).proxy
        proxy.header_map.role = "x-groups"
        proxy.header_map.role_map = {"admin": ["ops"], "garage": ["family"]}
        roles = {"admin", "viewer", "garage"}

        self.assertEqual(
            resolve_role({"x-groups": "family,ops"}, proxy, roles), "admin"
        )
        self.assertEqual(resolve_role({"x-groups": "family"}, proxy, roles), "garage")
        self.assertEqual(resolve_role({"x-groups": "other"}, proxy, roles), "viewer")

    def test_resolve_role_from_direct_role_names(self):
        proxy = FrigateConfig(**_config_dict()).proxy
        proxy.header_map.role = "x-role"
        roles = {"admin", "viewer", "garage"}

        self.assertEqual(resolve_role({"x-role": ""}, proxy, roles), "viewer")
        self.assertEqual(resolve_role({"x-role": "x, GARAGE"}, proxy, roles), "garage")
        self.assertEqual(resolve_role({"x-role": "nobody"}, proxy, roles), "viewer")


class TestCameraGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = FrigateConfig(**_config_dict())

    def _req(self, role=None, user="bob"):
        headers = {"remote-user": user, "remote-role": role} if role else {}
        return _request(headers, self.config)

    def test_camera_access(self):
        self.assertIsNone(_run(require_camera_access(None, self._req())))
        self.assertIsNone(_run(require_camera_access("back_yard", self._req("admin"))))
        self.assertIsNone(
            _run(require_camera_access("front_door", self._req("garage")))
        )

        with self.assertRaises(HTTPException) as denied:
            _run(require_camera_access("back_yard", self._req("garage")))
        self.assertEqual(denied.exception.status_code, 403)
        self.assertIn("['front_door']", denied.exception.detail)

        with self.assertRaises(HTTPException) as anonymous:
            _run(require_camera_access("front_door", self._req()))
        self.assertEqual(anonymous.exception.status_code, 401)
        self.assertEqual(anonymous.exception.detail, "No authorization headers.")

    def test_go2rtc_stream_access(self):
        self.assertIsNone(_run(require_go2rtc_stream_access(None, self._req())))
        self.assertIsNone(
            _run(require_go2rtc_stream_access("anything", self._req("viewer")))
        )
        self.assertIsNone(
            _run(require_go2rtc_stream_access("front_sub", self._req("garage")))
        )
        self.assertIsNone(
            _run(require_go2rtc_stream_access("front_door", self._req("garage")))
        )

        with self.assertRaises(HTTPException) as denied:
            _run(require_go2rtc_stream_access("back_yard", self._req("garage")))
        self.assertEqual(denied.exception.status_code, 403)

        with self.assertRaises(HTTPException) as anonymous:
            _run(require_go2rtc_stream_access("front_sub", self._req()))
        self.assertEqual(anonymous.exception.status_code, 401)

    def test_allowed_cameras_for_filter(self):
        self.assertEqual(_run(get_allowed_cameras_for_filter(self._req())), [])
        self.assertEqual(
            _run(get_allowed_cameras_for_filter(self._req("garage"))), ["front_door"]
        )
        self.assertEqual(
            sorted(_run(get_allowed_cameras_for_filter(self._req("viewer")))),
            ["back_yard", "front_door"],
        )

    def test_full_camera_access(self):
        request = self._req()

        self.assertIsNone(
            _run(require_full_camera_access(request, ["front_door", "back_yard"]))
        )

        with self.assertRaises(HTTPException) as ctx:
            _run(require_full_camera_access(request, ["front_door"]))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_go2rtc_proxy_paths(self):
        req = self._req()
        ws = "/live/mse/api/ws"

        self.assertIsNone(deny_response_for_go2rtc_stream(None, "garage", req))
        self.assertIsNone(deny_response_for_go2rtc_stream("/api/x", "garage", req))
        self.assertIsNone(deny_response_for_go2rtc_stream(f"{ws}?src=x", "admin", req))
        self.assertIsNone(deny_response_for_go2rtc_stream(f"{ws}?src=x", None, req))
        self.assertEqual(deny_response_for_go2rtc_stream(ws, "garage", req), 403)
        self.assertIsNone(
            deny_response_for_go2rtc_stream(f"{ws}?src=front_sub", "garage", req)
        )
        self.assertEqual(
            deny_response_for_go2rtc_stream(
                f"{ws}?src=front_sub&src=back_yard", "garage", req
            ),
            403,
        )


class _AuthHttpTestCase(BaseTestHttp):
    auth_options: dict = {}

    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, User, ShareLink])
        env = patch.dict(os.environ, {JWT_SECRET_ENV_VAR: _SECRET})
        env.start()
        self.addCleanup(env.stop)
        self.minimal_config = _config_dict(**self.auth_options)
        self.publisher = Mock(spec=CameraConfigUpdatePublisher)
        self.publisher.publisher = MagicMock()
        self.app = create_fastapi_app(
            FrigateConfig(**self.minimal_config),
            self.db,
            None,
            None,
            None,
            None,
            None,
            None,
            self.publisher,
            None,
            enforce_default_admin=False,
        )
        self.client = AuthTestClient(self.app)

        tracker = patch("frigate.api.auth.failed_logins")
        self.failed_logins = tracker.start()
        self.addCleanup(tracker.stop)
        seen = patch.dict(auth_api._first_load_seen, clear=True)
        seen.start()
        self.addCleanup(seen.stop)

    def _add_user(self, username, role="admin", password=_PASSWORD, changed=None):
        User.insert(
            username=username,
            password_hash=hash_password(password, iterations=10),
            role=role,
            password_changed_at=changed,
            notification_tokens=[],
        ).execute()

    def _token(self, user="bob", role="garage", exp_in=3600):
        return create_encoded_jwt(
            user, role, int(time.time()) + exp_in, self.app.jwt_token
        )

    def _auth(self, headers=None, cookie=None):
        headers = {"x-server-port": "8971", **(headers or {})}

        if cookie is not None:
            headers["cookie"] = f"frigate_token={cookie}"

        client = AuthTestClient(self.app)
        return client.get("/auth", headers=headers)


class TestAuthEndpointEnabled(_AuthHttpTestCase):
    def test_internal_port_is_anonymous_admin(self):
        response = self._auth({"x-server-port": "5000"})

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-user"], "anonymous")
        self.assertEqual(response.headers["remote-role"], "admin")

    def test_missing_token_redirects_to_login(self):
        response = self._auth()

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["location"], "/login")

    def test_cookie_token_is_accepted(self):
        response = self._auth(cookie=self._token())

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-user"], "bob")
        self.assertEqual(response.headers["remote-role"], "garage")
        self.assertNotIn("set-cookie", response.headers)

    def test_tokens_missing_a_claim_are_rejected(self):
        for claims in (
            {"role": "admin", "exp": 9999999999},
            {"sub": "bob", "exp": 9999999999},
            {"sub": "bob", "role": "admin"},
        ):
            with self.subTest(claims=claims):
                token = jwt.encode({"alg": "HS256"}, claims, self.app.jwt_token)
                response = self._auth({"authorization": f"Bearer {token}"})
                self.assertEqual(response.status_code, 401)

    def test_expired_token_is_rejected(self):
        response = self._auth(cookie=self._token(exp_in=-10))

        self.assertEqual(response.status_code, 401)

    def test_garbage_token_is_rejected(self):
        with self.assertLogs("frigate.api.auth", level="ERROR"):
            response = self._auth({"authorization": "Bearer not-a-jwt"})

        self.assertEqual(response.status_code, 401)

    def test_expiring_cookie_is_refreshed(self):
        self._add_user("bob", role="garage")

        response = self._auth(cookie=self._token(exp_in=60))

        self.assertEqual(response.status_code, 202)
        refreshed = response.cookies.get("frigate_token")
        self.assertIsNotNone(refreshed)
        claims = jwt.decode(refreshed, self.app.jwt_token).claims
        self.assertGreater(claims["exp"], int(time.time()) + 80000)
        self.assertEqual(claims["role"], "garage")

    def test_expiring_cookie_for_a_deleted_user_is_rejected(self):
        response = self._auth(cookie=self._token(exp_in=60))

        self.assertEqual(response.status_code, 401)

    def test_expiring_cookie_issued_before_a_password_change_is_rejected(self):
        self._add_user(
            "bob", role="garage", changed=datetime.now() + timedelta(hours=1)
        )

        response = self._auth(cookie=self._token(exp_in=60))

        self.assertEqual(response.status_code, 401)

    def test_expiring_cookie_issued_after_a_password_change_is_refreshed(self):
        self._add_user("bob", role="garage", changed=datetime.now() - timedelta(days=1))

        response = self._auth(cookie=self._token(exp_in=60))

        self.assertEqual(response.status_code, 202)
        self.assertIsNotNone(response.cookies.get("frigate_token"))

    def test_bearer_tokens_are_not_refreshed(self):
        token = self._token(exp_in=60)

        response = self._auth({"authorization": f"Bearer {token}"})

        self.assertEqual(response.status_code, 202)
        self.assertNotIn("set-cookie", response.headers)

    def test_restricted_role_is_denied_other_camera_media(self):
        token = self._token()
        mine = "/recordings/2026-01-01/10/front_door/00.00.mp4"
        theirs = "/recordings/2026-01-01/10/back_yard/00.00.mp4"

        allowed = self._auth({"x-original-url": mine}, cookie=token)
        denied = self._auth({"x-original-url": theirs}, cookie=token)

        self.assertEqual(allowed.status_code, 202)
        self.assertEqual(denied.status_code, 403)

    def test_restricted_role_is_denied_other_camera_streams(self):
        denied = self._auth(
            {"x-original-url": "/live/webrtc/api/ws?src=back_yard"},
            cookie=self._token(),
        )

        self.assertEqual(denied.status_code, 403)


class TestAuthEndpointProxySecret(_AuthHttpTestCase):
    def setUp(self):
        super().setUp()
        self.app.frigate_config.proxy.auth_secret = "shh"

    def test_wrong_proxy_secret_is_401(self):
        response = self._auth({"x-proxy-secret": "nope"}, cookie=self._token())

        self.assertEqual(response.status_code, 401)
        self.assertNotIn("location", response.headers)

    def test_matching_proxy_secret_continues(self):
        response = self._auth({"x-proxy-secret": "shh"}, cookie=self._token())

        self.assertEqual(response.status_code, 202)


class TestAuthEndpointDisabled(_AuthHttpTestCase):
    auth_options = {"enabled": False}

    def test_defaults_to_viewer(self):
        response = self._auth()

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-user"], "viewer")
        self.assertEqual(response.headers["remote-role"], "viewer")

    def test_proxy_headers_are_mapped(self):
        proxy = self.app.frigate_config.proxy
        proxy.header_map.user = "x-forwarded-user"
        proxy.header_map.role = "x-forwarded-role"

        response = self._auth(
            {"x-forwarded-user": "carol", "x-forwarded-role": "garage"}
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-user"], "carol")
        self.assertEqual(response.headers["remote-role"], "garage")

    def test_mapped_restricted_role_is_denied_media_and_streams(self):
        proxy = self.app.frigate_config.proxy
        proxy.header_map.role = "x-forwarded-role"
        role = {"x-forwarded-role": "garage"}

        media = self._auth(
            {
                **role,
                "x-original-url": "/recordings/2026-01-01/10/back_yard/00.00.mp4",
            }
        )
        stream = self._auth(
            {**role, "x-original-url": "/api/go2rtc/webrtc?src=back_yard"}
        )

        self.assertEqual(media.status_code, 403)
        self.assertEqual(stream.status_code, 403)

    def test_login_is_404(self):
        response = self.client.post("/login", json={"user": "a", "password": "b"})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"message": "Authentication is disabled"})


class TestSessionEndpoints(_AuthHttpTestCase):
    def test_first_time_login_flag(self):
        auth_config = self.app.frigate_config.auth

        self.assertEqual(
            self.client.get("/auth/first_time_login").json(),
            {"admin_first_time_login": False},
        )
        auth_config.reset_admin_password = True
        self.assertEqual(
            self.client.get("/auth/first_time_login").json(),
            {"admin_first_time_login": True},
        )

    def test_logout_clears_the_cookie(self):
        response = self.client.get("/logout", follow_redirects=False)

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/login")
        self.assertIn('frigate_token=""', response.headers["set-cookie"])

    def test_profile_reports_allowed_cameras(self):
        response = self.client.get(
            "/profile", headers={"remote-user": "bob", "remote-role": "garage"}
        )

        self.assertEqual(
            response.json(),
            {"username": "bob", "role": "garage", "allowed_cameras": ["front_door"]},
        )

    def test_profile_requires_authentication(self):
        response = self.client.get(
            "/profile", headers={"remote-user": "anonymous", "remote-role": "viewer"}
        )

        self.assertEqual(response.status_code, 401)

    def test_anonymous_profile_is_logged_once_per_client(self):
        headers = {
            "remote-user": "anonymous",
            "remote-role": "admin",
            "user-agent": "probe",
        }
        auth_api._first_load_seen["stale"] = time.time() - 1

        with self.assertLogs("frigate.api.auth", level="INFO") as logs:
            first = self.client.get("/profile", headers=headers)
            self.client.get("/profile", headers=headers)

        self.assertEqual(first.json()["username"], "anonymous")
        anonymous = [line for line in logs.output if "Anonymous user access" in line]
        self.assertEqual(len(anonymous), 1)
        self.assertIn("ua=probe", anonymous[0])
        self.assertNotIn("stale", auth_api._first_load_seen)
        self.assertEqual(len(auth_api._first_load_seen), 1)

    def test_anonymous_profile_survives_an_address_error(self):
        headers = {"remote-user": "anonymous", "remote-role": "admin"}

        with patch("frigate.api.auth.get_remote_addr", side_effect=ValueError("bad")):
            response = self.client.get("/profile", headers=headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(auth_api._first_load_seen), 1)


class TestLogin(_AuthHttpTestCase):
    auth_options = {"admin_first_time_login": True, "cookie_secure": True}

    def _login(self, user, password=_PASSWORD):
        return self.client.post("/login", json={"user": user, "password": password})

    def test_admin_login_sets_a_cookie_and_clears_the_first_time_flag(self):
        self._add_user("admin")

        response = self._login("admin")

        self.assertEqual(response.status_code, 200)
        self.assertIn("Secure", response.headers["set-cookie"])
        claims = jwt.decode(
            response.cookies.get("frigate_token"), self.app.jwt_token
        ).claims
        self.assertEqual((claims["sub"], claims["role"]), ("admin", "admin"))
        self.assertFalse(self.app.frigate_config.auth.admin_first_time_login)
        self.failed_logins.record.assert_not_called()

    def test_custom_role_login_keeps_the_first_time_flag(self):
        self._add_user("bob", role="garage")

        response = self._login("bob")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.app.frigate_config.auth.admin_first_time_login)

    def test_unknown_role_falls_back_to_viewer(self):
        self._add_user("bob", role="retired")

        with self.assertLogs("frigate.api.auth", level="WARNING"):
            response = self._login("bob")

        claims = jwt.decode(
            response.cookies.get("frigate_token"), self.app.jwt_token
        ).claims
        self.assertEqual(claims["role"], "viewer")

    def test_failed_logins(self):
        self._add_user("bob", role="garage")

        wrong = self._login("bob", "nope")
        missing = self._login("ghost")

        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong.json(), {"message": "Login failed"})
        self.assertEqual(self.failed_logins.record.call_count, 2)


class TestLoginRateLimit(_AuthHttpTestCase):
    def setUp(self):
        super().setUp()
        limiter = auth_api.limiter
        old_enabled = limiter.enabled
        old_limit = auth_api.rateLimiter.get_limit()

        def restore():
            limiter.reset()
            limiter.enabled = old_enabled
            auth_api.rateLimiter.set_limit(old_limit)

        self.addCleanup(restore)
        limiter.reset()
        limiter.enabled = True
        auth_api.rateLimiter.set_limit("2/minute")

    def test_login_is_rate_limited_per_client(self):
        codes = [
            self.client.post("/login", json={"user": "x", "password": "y"}).status_code
            for _ in range(3)
        ]

        self.assertEqual(codes, [401, 401, 429])


class TestUserManagement(_AuthHttpTestCase):
    def test_list_users(self):
        self._add_user("zed", role="viewer")
        self._add_user("admin")

        response = self.client.get("/users")

        self.assertEqual(
            response.json(),
            [
                {"username": "admin", "role": "admin"},
                {"username": "zed", "role": "viewer"},
            ],
        )

    def test_user_endpoints_require_admin(self):
        viewer = {"remote-user": "v", "remote-role": "viewer"}

        self.assertEqual(self.client.get("/users", headers=viewer).status_code, 403)
        self.assertEqual(
            self.client.delete("/users/bob", headers=viewer).status_code, 403
        )

    def test_create_user_validation(self):
        for body, message in (
            (
                {"username": "bad name", "password": "x" * 12, "role": "viewer"},
                "Invalid username",
            ),
            (
                {"username": "bob", "password": "x" * 12, "role": "root"},
                "Role must be one of",
            ),
            (
                {"username": "bob", "password": "short", "role": "viewer"},
                "at least 12 characters",
            ),
        ):
            with self.subTest(body=body):
                response = self.client.post("/users", json=body)
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.json()["message"])

        self.assertEqual(User.select().count(), 0)
        self.publisher.publisher.publish.assert_not_called()

    def test_create_user(self):
        response = self.client.post(
            "/users",
            json={"username": "bob.s", "password": "x" * 12, "role": "garage"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"username": "bob.s"})
        user = User.get_by_id("bob.s")
        self.assertEqual(user.role, "garage")
        self.assertTrue(user.password_hash.startswith("pbkdf2_sha256$10$"))
        self.assertTrue(verify_password("x" * 12, user.password_hash))
        self.publisher.publisher.publish.assert_called_once_with("config/auth", None)

    def test_admin_cannot_be_deleted(self):
        self._add_user("admin")

        response = self.client.delete("/users/admin")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(User.select().count(), 1)

    def test_delete_user_removes_their_share_links(self):
        self._add_user("bob", role="garage")
        for token, owner in (("t1", "bob"), ("t2", "carol")):
            ShareLink.insert(
                token=token,
                event_id="e1",
                camera="front_door",
                created_by=owner,
                created_at=time.time(),
                expires_at=time.time() + 60,
            ).execute()

        response = self.client.delete("/users/bob")

        self.assertEqual(response.json(), {"success": True})
        self.assertFalse(User.select().where(User.username == "bob").exists())
        self.assertEqual([link.token for link in ShareLink.select()], ["t2"])
        self.publisher.publisher.publish.assert_called_once_with("config/auth", None)

    def test_update_role(self):
        self._add_user("bob", role="viewer")

        response = self.client.put("/users/bob/role", json={"role": "garage"})

        self.assertEqual(response.json(), {"success": True})
        self.assertEqual(User.get_by_id("bob").role, "garage")
        self.publisher.publisher.publish.assert_called_once_with("config/auth", None)

    def test_update_role_rejections(self):
        self._add_user("admin")

        protected = self.client.put("/users/admin/role", json={"role": "viewer"})
        unknown = self.client.put("/users/bob/role", json={"role": "root"})
        viewer = self.client.put(
            "/users/bob/role",
            json={"role": "garage"},
            headers={"remote-user": "v", "remote-role": "viewer"},
        )
        nameless = self.client.put(
            "/users/bob/role",
            json={"role": "garage"},
            headers={"remote-user": "", "remote-role": "admin"},
        )

        self.assertEqual(protected.status_code, 403)
        self.assertEqual(unknown.status_code, 400)
        self.assertIn("Role must be one of", unknown.json()["message"])
        self.assertEqual(viewer.status_code, 403)
        self.assertEqual(nameless.status_code, 401)
        self.assertEqual(User.get_by_id("admin").role, "admin")
        self.publisher.publisher.publish.assert_not_called()


class TestUpdatePassword(_AuthHttpTestCase):
    def _put(self, target, body, user="bob", role="garage"):
        return self.client.put(
            f"/users/{target}/password",
            json=body,
            headers={"remote-user": user, "remote-role": role},
        )

    def test_unknown_user_is_404(self):
        response = self._put("ghost", {"password": "x" * 12}, "admin", "admin")

        self.assertEqual(response.status_code, 404)

    def test_missing_current_user_headers_is_401(self):
        response = self._put("bob", {"password": "x" * 12}, "", "admin")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"message": "No authorization headers."})

    def test_non_admin_must_send_the_current_password(self):
        self._add_user("bob", role="garage")

        response = self._put("bob", {"password": "x" * 12})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "Current password is required")

    def test_wrong_current_password_is_401(self):
        self._add_user("bob", role="garage")

        response = self._put("bob", {"password": "y" * 12, "old_password": "nope"})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["message"], "Current password is incorrect")
        self.assertTrue(verify_password(_PASSWORD, User.get_by_id("bob").password_hash))

    def test_weak_new_password_is_400(self):
        self._add_user("bob", role="garage")

        response = self._put("bob", {"password": "short", "old_password": _PASSWORD})

        self.assertEqual(response.status_code, 400)
        self.assertTrue(verify_password(_PASSWORD, User.get_by_id("bob").password_hash))

    def test_own_change_rotates_the_cookie(self):
        self._add_user("bob", role="garage")

        response = self._put("bob", {"password": "y" * 12, "old_password": _PASSWORD})

        self.assertEqual(response.status_code, 200)
        user = User.get_by_id("bob")
        self.assertTrue(verify_password("y" * 12, user.password_hash))
        self.assertIsNotNone(user.password_changed_at)
        claims = jwt.decode(
            response.cookies.get("frigate_token"), self.app.jwt_token
        ).claims
        self.assertEqual((claims["sub"], claims["role"]), ("bob", "garage"))

    def test_admin_change_of_another_user_sets_no_cookie(self):
        self._add_user("bob", role="garage")

        response = self._put("bob", {"password": "y" * 12}, "admin", "admin")

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)
        self.assertTrue(verify_password("y" * 12, User.get_by_id("bob").password_hash))
