"""nginx tells the /ws server which session opened a connection (E27).

A revoke closes the connections of its session, and the /ws server can only
tell them apart by the Remote-Session header nginx sets from /auth.
"""

import unittest
from pathlib import Path

CONF_DIR = (
    Path(__file__).resolve().parents[2] / "docker/main/rootfs/usr/local/nginx/conf"
)


def block(text: str, header: str) -> str:
    """Return the body of the first `header { ... }` block, braces balanced."""
    start = text.index(header)
    depth = 0
    for index in range(text.index("{", start), len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise AssertionError(f"unbalanced block: {header}")


class TestNginxSessionConf(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.auth_request = (CONF_DIR / "auth_request.conf").read_text()
        cls.nginx = (CONF_DIR / "nginx.conf").read_text()

    def test_the_session_from_auth_is_passed_on(self):
        self.assertIn(
            "auth_request_set $fork_session $upstream_http_remote_session;",
            self.auth_request,
        )
        self.assertIn(
            "proxy_set_header Remote-Session $fork_session;", self.auth_request
        )

    def test_a_client_cannot_name_a_session_itself(self):
        # proxy_set_header replaces a client's header of the same name, and
        # with no session from /auth it sends none, so it is set exactly once
        self.assertEqual(self.auth_request.count("Remote-Session"), 1)
        self.assertNotIn("Remote-Session", (CONF_DIR / "proxy.conf").read_text())

    def test_every_websocket_location_asks_auth(self):
        for location in (
            "location /ws {",
            "location /live/jsmpeg/ {",
            "location /live/mse/api/ws {",
            "location /live/webrtc/api/ws {",
        ):
            with self.subTest(location=location):
                self.assertIn("include auth_request.conf;", block(self.nginx, location))


if __name__ == "__main__":
    unittest.main()
