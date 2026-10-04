"""Ending a session closes its open /ws connections and stops its push
notifications (fork E27)."""

import base64
import json
import threading
import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from ws4py.client.threadedclient import WebSocketClient as WsTestClient

from frigate.comms.ws import WebSocketClient
from frigate.config import FrigateConfig
from frigate.fork import session_reach
from frigate.fork.session_reach import (
    SESSION_CLOSE_CODE,
    UserSessionPush,
    close_session_sockets,
    detach_push,
)
from frigate.fork.sessions import session_store, socket_session_ended
from frigate.models import User
from frigate.test.http_api.test_http_fork_sessions import (
    _NEW_PASSWORD,
    _PASSWORD,
    _SAFARI_IPHONE,
    _config,
    _SessionsTestCase,
)

# a p256dh key has to decode to 65 bytes for pywebpush to accept it
_P256DH = base64.urlsafe_b64encode(b"\x04" + bytes(range(64))).decode().rstrip("=")
_AUTH = base64.urlsafe_b64encode(bytes(range(16))).decode().rstrip("=")
_ENDPOINT = "https://fcm.googleapis.com/fcm/send/phone-of-bob"
_OTHER_ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/laptop-of-bob"


def _subscription(endpoint: str = _ENDPOINT) -> dict:
    return {"endpoint": endpoint, "keys": {"p256dh": _P256DH, "auth": _AUTH}}


class _Socket:
    """A ws4py connection as close_session_sockets sees it."""

    def __init__(self, user: str | None, session: str | None) -> None:
        self.environ: dict[str, str] = {}
        if user is not None:
            self.environ["HTTP_REMOTE_USER"] = user
        if session is not None:
            self.environ["HTTP_REMOTE_SESSION"] = session
        self.server_terminated = False
        self.closed_with: tuple[int, str] | None = None
        self.sock = MagicMock()

    def close(self, code: int = 1000, reason: str = "") -> None:
        self.server_terminated = True
        self.closed_with = (code, reason)


def _manager(sockets: list[_Socket]) -> Any:
    return SimpleNamespace(
        lock=threading.Lock(), websockets={id(ws): ws for ws in sockets}
    )


class _ReachTestCase(_SessionsTestCase):
    def setUp(self):
        super().setUp()
        self.manager = _manager([])
        self.pushes = SimpleNamespace(
            web_pushers={"admin": [], "bob": [], "eve": []}, refresh=1
        )
        ws_client = SimpleNamespace(
            websocket_server=SimpleNamespace(manager=self.manager)
        )
        self.app.dispatcher = SimpleNamespace(comms=[ws_client, self.pushes])

    def _socket(self, user: str | None, token: str | None) -> _Socket:
        session = None if token is None else self._claims(token).get("jti")
        ws = _Socket(user, session)
        self.manager.websockets[id(ws)] = ws
        return ws

    def _tokens(self, user: str) -> list[str]:
        return [t["endpoint"] for t in User.get_by_id(user).notification_tokens]

    def _pushing_to(self, user: str) -> list[str]:
        return [p.subscription_info["endpoint"] for p in self.pushes.web_pushers[user]]

    def _register(self, user: str, role: str, token: str, endpoint: str = _ENDPOINT):
        response = self.client.post(
            "/notifications/register",
            json={"sub": _subscription(endpoint)},
            headers=self._as(user, role, token),
        )
        self.assertEqual(response.status_code, 200)

    def _link(self, endpoint: str) -> UserSessionPush | None:
        return UserSessionPush.get_or_none(UserSessionPush.endpoint == endpoint)


class TestAuthNamesTheSession(_SessionsTestCase):
    def test_auth_passes_the_session_on(self):
        token = self._login("bob")

        response = self._auth(token)

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-session"], self._claims(token)["jti"])

    def test_a_token_without_a_session_names_none(self):
        response = self._auth(self._legacy_token("bob", "garage", 3600))

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers.get("remote-session", ""), "")


class TestRevokeClosesSockets(_ReachTestCase):
    def test_revoke_closes_only_that_sessions_sockets(self):
        token = self._login("bob")
        other = self._login("bob", _SAFARI_IPHONE)
        revoked = self._socket("bob", token)
        kept = self._socket("bob", other)

        response = self.client.delete(
            f"/fork/sessions/{self._claims(token)['jti']}",
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(revoked.closed_with, (SESSION_CLOSE_CODE, "session ended"))
        revoked.sock.shutdown.assert_called_once()
        self.assertIsNone(kept.closed_with)

    def test_logout_closes_the_sessions_sockets(self):
        token = self._login("bob")
        ws = self._socket("bob", token)

        self.client.get(
            "/logout",
            headers={"cookie": f"frigate_token={token}"},
            follow_redirects=False,
        )

        self.assertEqual(ws.closed_with[0], SESSION_CLOSE_CODE)

    def test_password_change_closes_every_socket_of_the_user(self):
        token = self._login("bob")
        mine = self._socket("bob", token)
        phone = self._socket("bob", self._login("bob", _SAFARI_IPHONE))
        legacy = self._socket("bob", None)
        eve = self._socket("eve", self._login("eve"))

        response = self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD, "old_password": _PASSWORD},
            headers=self._as("bob", "garage", token),
        )

        self.assertEqual(response.status_code, 200)
        # this one too: it reconnects with the new cookie
        for ws in (mine, phone, legacy):
            self.assertEqual(ws.closed_with[0], SESSION_CLOSE_CODE)
        self.assertIsNone(eve.closed_with)

    def test_role_change_and_delete_close_the_users_sockets(self):
        role = self._socket("bob", self._login("bob"))
        self.client.put(
            "/users/bob/role",
            json={"role": "viewer"},
            headers=self._as("admin", "admin"),
        )
        self.assertEqual(role.closed_with[0], SESSION_CLOSE_CODE)

        deleted = self._socket("eve", self._login("eve"))
        self.client.delete("/users/eve", headers=self._as("admin", "admin"))
        self.assertEqual(deleted.closed_with[0], SESSION_CLOSE_CODE)

    def test_sign_out_other_sessions_keeps_the_callers_socket(self):
        token = self._login("bob")
        mine = self._socket("bob", token)
        phone = self._socket("bob", self._login("bob", _SAFARI_IPHONE))

        response = self.client.post(
            "/fork/sessions/revoke_all",
            json={"keep_current": True},
            headers=self._as("bob", "garage", token),
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(mine.closed_with)
        self.assertEqual(phone.closed_with[0], SESSION_CLOSE_CODE)

    def test_without_a_websocket_server_nothing_is_closed(self):
        self.assertEqual(close_session_sockets(SimpleNamespace(), {"x"}, "bob"), 0)
        self.app.dispatcher = None
        self.assertEqual(close_session_sockets(self.app, {"x"}, "bob"), 0)

    def test_a_socket_already_gone_is_closed_quietly(self):
        token = self._login("bob")
        ws = self._socket("bob", token)
        ws.sock.shutdown.side_effect = OSError("not connected")
        ws2 = self._socket("bob", None)
        ws2.sock = None

        closed = close_session_sockets(self.app, (), "bob")

        self.assertEqual(closed, 2)
        self.assertEqual(ws.closed_with[0], SESSION_CLOSE_CODE)


class TestInboundAfterRevoke(_ReachTestCase):
    def test_a_revoked_sessions_socket_takes_no_commands(self):
        token = self._login("bob")
        jti = self._claims(token)["jti"]
        ws = _Socket("bob", jti)

        self.assertFalse(socket_session_ended(ws))

        # revoked while the socket was still opening, so it was never closed
        session_store(self.app).revoke({jti: time.time() + 3600}, time.time(), 86400)

        self.assertTrue(socket_session_ended(ws))
        self.assertEqual(ws.closed_with[0], SESSION_CLOSE_CODE)

    def test_a_closed_socket_takes_no_commands(self):
        ws = _Socket("bob", None)
        self.assertFalse(socket_session_ended(ws))

        ws.server_terminated = True

        self.assertTrue(socket_session_ended(ws))


class TestPushFollowsTheSession(_ReachTestCase):
    def test_register_ties_the_subscription_to_the_session(self):
        token = self._login("bob")

        self._register("bob", "garage", token)

        link = self._link(_ENDPOINT)
        self.assertEqual(link.username, "bob")
        self.assertEqual(link.session_id, self._claims(token)["jti"])
        # pushed to at once, and the next send signs a claim for its service
        self.assertEqual(self._pushing_to("bob"), [_ENDPOINT])
        self.assertEqual(self.pushes.refresh, 0)

    def test_revoke_stops_the_devices_notifications(self):
        token = self._login("bob")
        laptop = self._login("bob", _SAFARI_IPHONE)
        self._register("bob", "garage", token)
        self._register("bob", "garage", laptop, _OTHER_ENDPOINT)

        self.client.delete(
            f"/fork/sessions/{self._claims(token)['jti']}",
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(self._tokens("bob"), [_OTHER_ENDPOINT])
        self.assertEqual(self._pushing_to("bob"), [_OTHER_ENDPOINT])
        # the link stays, with no session, so bob can get it back
        self.assertEqual(self._link(_ENDPOINT).username, "bob")
        self.assertIsNone(self._link(_ENDPOINT).session_id)

    def test_logout_stops_the_devices_notifications(self):
        token = self._login("bob")
        self._register("bob", "garage", token)

        self.client.get(
            "/logout",
            headers={"cookie": f"frigate_token={token}"},
            follow_redirects=False,
        )

        self.assertEqual(self._tokens("bob"), [])
        self.assertEqual(self._pushing_to("bob"), [])

    def test_signing_in_again_restores_them(self):
        token = self._login("bob")
        self._register("bob", "garage", token)
        self.client.get(
            "/logout",
            headers={"cookie": f"frigate_token={token}"},
            follow_redirects=False,
        )
        again = self._login("bob")

        response = self.client.put(
            "/fork/sessions/push",
            json={"sub": _subscription()},
            headers=self._as("bob", "garage", again),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"success": True, "linked": True})
        self.assertEqual(self._tokens("bob"), [_ENDPOINT])
        self.assertEqual(self._pushing_to("bob"), [_ENDPOINT])
        self.assertEqual(self._link(_ENDPOINT).session_id, self._claims(again)["jti"])

    def test_someone_else_signing_in_does_not_get_them(self):
        token = self._login("bob")
        self._register("bob", "garage", token)
        self.client.get(
            "/logout",
            headers={"cookie": f"frigate_token={token}"},
            follow_redirects=False,
        )
        eve = self._login("eve")

        response = self.client.put(
            "/fork/sessions/push",
            json={"sub": _subscription()},
            headers=self._as("eve", "viewer", eve),
        )

        self.assertEqual(response.json(), {"success": True, "linked": False})
        self.assertEqual(self._tokens("eve"), [])
        self.assertEqual(self._pushing_to("eve"), [])
        self.assertIsNone(self._link(_ENDPOINT).session_id)

    def test_opening_the_app_ties_an_older_subscription(self):
        # registered before links existed
        User.update(notification_tokens=[_subscription()]).where(
            User.username == "bob"
        ).execute()
        token = self._login("bob")

        response = self.client.put(
            "/fork/sessions/push",
            json={"sub": _subscription()},
            headers=self._as("bob", "garage", token),
        )

        self.assertTrue(response.json()["linked"])
        self.assertEqual(self._link(_ENDPOINT).session_id, self._claims(token)["jti"])
        self.assertEqual(self._tokens("bob"), [_ENDPOINT])

    def test_a_subscription_never_registered_is_left_alone(self):
        token = self._login("bob")

        response = self.client.put(
            "/fork/sessions/push",
            json={"sub": _subscription()},
            headers=self._as("bob", "garage", token),
        )

        self.assertFalse(response.json()["linked"])
        self.assertEqual(self._tokens("bob"), [])
        self.assertIsNone(self._link(_ENDPOINT))

    def test_a_sign_in_without_a_session_links_nothing(self):
        legacy = self._legacy_token("bob", "garage", 3600)

        response = self.client.put(
            "/fork/sessions/push",
            json={"sub": _subscription()},
            headers=self._as("bob", "garage", legacy),
        )

        self.assertEqual(response.json(), {"success": True, "linked": False})

    def test_an_invalid_subscription_is_refused(self):
        token = self._login("bob")

        response = self.client.put(
            "/fork/sessions/push",
            json={"sub": {"endpoint": "http://192.168.1.2/push"}},
            headers=self._as("bob", "garage", token),
        )

        self.assertEqual(response.status_code, 400)

    def test_sign_out_everywhere_stops_every_device_even_unlinked(self):
        token = self._login("bob")
        self._register("bob", "garage", token)
        # one from before links existed, on some other device
        User.update(
            notification_tokens=User.notification_tokens.append(
                _subscription(_OTHER_ENDPOINT)
            )
        ).where(User.username == "bob").execute()

        self.client.post(
            "/fork/sessions/revoke_all",
            json={"username": "bob"},
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(self._tokens("bob"), [])
        self.assertEqual(self._pushing_to("bob"), [])
        # both can come back when bob signs in on those devices
        for endpoint in (_ENDPOINT, _OTHER_ENDPOINT):
            self.assertEqual(self._link(endpoint).username, "bob")
            self.assertIsNone(self._link(endpoint).session_id)

    def test_sign_out_other_sessions_keeps_this_devices(self):
        token = self._login("bob")
        phone = self._login("bob", _SAFARI_IPHONE)
        self._register("bob", "garage", token)
        self._register("bob", "garage", phone, _OTHER_ENDPOINT)

        self.client.post(
            "/fork/sessions/revoke_all",
            json={"keep_current": True},
            headers=self._as("bob", "garage", token),
        )

        self.assertEqual(self._tokens("bob"), [_ENDPOINT])
        self.assertEqual(self._pushing_to("bob"), [_ENDPOINT])

    def test_password_change_stops_every_device(self):
        token = self._login("bob")
        self._register("bob", "garage", token)

        self.client.put(
            "/users/bob/password",
            json={"password": _NEW_PASSWORD},
            headers=self._as("admin", "admin"),
        )

        self.assertEqual(self._tokens("bob"), [])
        self.assertEqual(self._pushing_to("bob"), [])

    def test_deleting_the_user_forgets_their_links(self):
        token = self._login("bob")
        self._register("bob", "garage", token)

        self.client.delete("/users/bob", headers=self._as("admin", "admin"))

        self.assertIsNone(self._link(_ENDPOINT))
        self.assertEqual(self._pushing_to("bob"), [])

    def test_a_user_added_since_startup_waits_for_a_restart(self):
        # the sender has no list for them; one is never added under it
        del self.pushes.web_pushers["eve"]
        token = self._login("eve")

        self._register("eve", "viewer", token)

        self.assertNotIn("eve", self.pushes.web_pushers)
        self.assertEqual(self._link(_ENDPOINT).username, "eve")

    def test_an_unusable_key_is_not_pushed_to(self):
        token = self._login("bob")
        broken = _subscription()
        broken["keys"]["p256dh"] = "dG9vLXNob3J0"

        with self.assertLogs("frigate.fork.session_reach", level="WARNING"):
            session_reach.link_push(self.app, "bob", self._claims(token)["jti"], broken)

        self.assertEqual(self._pushing_to("bob"), [])

    def test_nothing_to_detach_is_a_no_op(self):
        self.assertEqual(detach_push(self.app, {"no-such-session"}), 0)


class _Client(WsTestClient):
    """A ws4py client that records the close code it was sent."""

    def __init__(self, url: str, headers: list[tuple[str, str]]) -> None:
        super().__init__(url, headers=headers)
        self.closed_code: int | None = None
        self.closed_event = threading.Event()

    def closed(self, code: int, reason: str | None = None) -> None:
        self.closed_code = code
        self.closed_event.set()


class _Receiver:
    """Records the commands the /ws server passes on."""

    def __init__(self, received: list[tuple[str, Any]], got: threading.Event):
        self.received = received
        self.got = got

    def receive(self, topic: str, payload: Any) -> None:
        self.received.append((topic, payload))
        self.got.set()


class TestRealWebsocket(_SessionsTestCase):
    """The /ws server itself, on its real port, as nginx would reach it."""

    received: list[tuple[str, Any]]
    got_message: threading.Event
    ws_client: WebSocketClient

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.received = []
        cls.got_message = threading.Event()
        cls.ws_client = WebSocketClient(FrigateConfig(**_config()))
        # a bound method, as the dispatcher's is: a plain function would be
        # bound to the handler class that keeps it
        cls.ws_client.subscribe(_Receiver(cls.received, cls.got_message).receive)

    @classmethod
    def tearDownClass(cls):
        cls.ws_client.stop()
        # stop() leaves the port bound
        cls.ws_client.websocket_server.server_close()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.received.clear()
        self.app.dispatcher = SimpleNamespace(comms=[self.ws_client])

    def _connect(self, token: str) -> _Client:
        client = _Client(
            "ws://127.0.0.1:5002/ws",
            headers=[
                ("Remote-User", "bob"),
                ("Remote-Role", "admin"),
                ("Remote-Session", self._claims(token)["jti"]),
            ],
        )
        client.connect()
        self.addCleanup(client.close)
        # the server adds the connection to its manager just after the handshake
        jti = self._claims(token)["jti"]
        manager = self.ws_client.websocket_server.manager
        deadline = time.time() + 5
        while time.time() < deadline:
            with manager.lock:
                sockets = list(manager.websockets.values())
            sessions = [ws.environ.get("HTTP_REMOTE_SESSION") for ws in sockets]
            if jti in sessions:
                break
            time.sleep(0.01)
        return client

    def _command(self, client: _Client) -> None:
        self.got_message.clear()
        client.send(json.dumps({"topic": "front_door/detect/set", "payload": "ON"}))

    def test_a_revoke_closes_the_connection_with_4401(self):
        token = self._login("bob")
        client = self._connect(token)
        self._command(client)
        self.assertTrue(self.got_message.wait(5))

        self.client.delete(
            f"/fork/sessions/{self._claims(token)['jti']}",
            headers=self._as("admin", "admin"),
        )

        self.assertTrue(client.closed_event.wait(5))
        self.assertEqual(client.closed_code, SESSION_CLOSE_CODE)

    def test_a_connection_opened_during_a_revoke_takes_no_command(self):
        token = self._login("bob")
        client = self._connect(token)
        jti = self._claims(token)["jti"]
        # revoked without its sockets closed, as if it opened mid-revoke
        session_store(self.app).revoke({jti: time.time() + 3600}, time.time(), 86400)

        self._command(client)

        self.assertTrue(client.closed_event.wait(5))
        self.assertEqual(client.closed_code, SESSION_CLOSE_CODE)
        self.assertEqual(self.received, [])
