"""The cross-origin websocket check keeps the fork's own clients working (E33).

Upstream #24714 refuses a browser handshake from a foreign Origin. These cases
pin down the clients that must still connect through the authenticated port:
the fork's web UI (same origin), the native Android viewer (OkHttp sends no
Origin header on a WebSocket handshake) and the Home Assistant integration,
which talks to Frigate server to server without a browser Origin.
"""

import unittest
from unittest.mock import MagicMock, patch

import requests
from ws4py.server.wsgiutils import WebSocketWSGIApplication

from frigate.comms.ws import OriginCheckedWebSocketApplication, WebSocket
from frigate.test.http_api.test_http_fork_sessions import _SessionsTestCase

_HOST = "frigate.lan:8971"


class TestAuthOriginClients(_SessionsTestCase):
    def setUp(self):
        super().setUp()
        # stream names resolve from the config; go2rtc itself is not running
        get_patch = patch(
            "frigate.api.auth.requests.get",
            side_effect=requests.ConnectionError("go2rtc unavailable"),
        )
        get_patch.start()
        self.addCleanup(get_patch.stop)

    def _handshake(self, token: str, original_url: str, **headers: str):
        # the headers auth_location.conf passes to /auth for a websocket
        sent = {
            "x-server-port": "8971",
            "x-original-url": original_url,
            "x-original-upgrade": "websocket",
            "x-original-host": _HOST,
            "cookie": f"frigate_token={token}",
        }
        if original_url.startswith("/live/"):
            sent["x-go2rtc-stream-proxy"] = "1"
        sent.update({k.replace("_", "-"): v for k, v in headers.items()})
        return self.client.get("/auth", headers=sent)

    def test_android_viewer_event_feed_without_origin_is_allowed(self):
        response = self._handshake(self._login("bob"), "/ws")

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-user"], "bob")

    def test_android_viewer_mse_stream_without_origin_is_allowed(self):
        response = self._handshake(
            self._login("bob"), "/live/mse/api/ws?src=front_door"
        )

        self.assertEqual(response.status_code, 202)

    def test_web_ui_same_origin_is_allowed(self):
        token = self._login("bob")

        for url in ("/ws", "/live/mse/api/ws?src=front_door"):
            with self.subTest(url=url):
                response = self._handshake(token, url, origin=f"https://{_HOST}")
                self.assertEqual(response.status_code, 202)

    def test_signed_in_browser_on_another_site_is_refused(self):
        # a page on another host of the same site still sends the cookie
        token = self._login("admin")

        for url in ("/ws", "/live/mse/api/ws?src=front_door"):
            with self.subTest(url=url):
                response = self._handshake(token, url, origin="http://ha.lan:8123")
                self.assertEqual(response.status_code, 403)
                self.assertNotIn("remote-user", response.headers)

    def test_home_assistant_integration_on_the_internal_port_is_allowed(self):
        response = self.client.get(
            "/auth",
            headers={
                "x-server-port": "5000",
                "x-original-url": "/ws",
                "x-original-upgrade": "websocket",
                "x-original-host": "frigate.lan:5000",
            },
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers["remote-role"], "admin")


class TestOriginCheckedApplicationClients(unittest.TestCase):
    """The ws4py servers behind nginx (/ws and jsmpeg) apply the same rule."""

    def _call(self, environ: dict[str, str]):
        app = OriginCheckedWebSocketApplication(handler_cls=WebSocket)
        start_response = MagicMock()

        with patch.object(
            WebSocketWSGIApplication, "__call__", return_value=["upgraded"]
        ) as upgrade:
            body = app(environ, start_response)

        return body, upgrade, start_response

    def test_okhttp_handshake_reaches_ws4py(self):
        # the request headers OkHttp sends on newWebSocket, as nginx forwards them
        body, upgrade, start_response = self._call(
            {
                "REQUEST_METHOD": "GET",
                "HTTP_HOST": "frigate.lan",
                "HTTP_X_FORWARDED_HOST": _HOST,
                "HTTP_UPGRADE": "websocket",
                "HTTP_CONNECTION": "Upgrade",
                "HTTP_SEC_WEBSOCKET_KEY": "AAAAAAAAAAAAAAAAAAAAAA==",
                "HTTP_SEC_WEBSOCKET_VERSION": "13",
                "HTTP_COOKIE": "frigate_token=token",
            }
        )

        self.assertEqual(body, ["upgraded"])
        upgrade.assert_called_once()
        start_response.assert_not_called()

    def test_web_ui_handshake_reaches_ws4py(self):
        body, upgrade, _ = self._call(
            {
                "REQUEST_METHOD": "GET",
                "HTTP_ORIGIN": f"https://{_HOST}",
                "HTTP_HOST": "frigate.lan",
                "HTTP_X_FORWARDED_HOST": _HOST,
            }
        )

        self.assertEqual(body, ["upgraded"])
        upgrade.assert_called_once()

    def test_foreign_page_never_reaches_ws4py(self):
        body, upgrade, start_response = self._call(
            {
                "REQUEST_METHOD": "GET",
                "HTTP_ORIGIN": "http://frigate.lan.evil.example",
                "HTTP_HOST": "frigate.lan",
                "HTTP_X_FORWARDED_HOST": _HOST,
            }
        )

        self.assertEqual(body, [])
        upgrade.assert_not_called()
        self.assertEqual(start_response.call_args.args[0], "403 Forbidden")
