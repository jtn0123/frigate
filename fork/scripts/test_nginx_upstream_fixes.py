"""nginx keeps the upstream 0.19 fixes ported by E34."""

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


class TestNginxUpstreamFixes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.auth_location = (CONF_DIR / "auth_location.conf").read_text()
        cls.nginx = (CONF_DIR / "nginx.conf").read_text()

    def test_auth_does_not_warn_about_the_stream_proxy_marker(self):
        # only the go2rtc stream locations set $go2rtc_stream_proxy, so every
        # other request logged a warning (upstream #24682)
        auth = block(self.auth_location, "location /auth {")
        self.assertIn("$go2rtc_stream_proxy", auth)
        self.assertIn("uninitialized_variable_warn off;", auth)

    def test_review_thumbnails_skip_the_open_file_cache(self):
        # review thumbnails are rewritten in place, and a cached file size
        # served them truncated or aborted mid-transfer (upstream #24727)
        self.assertIn("open_file_cache max=", self.nginx)
        clips = block(self.nginx, "location /clips/ {")
        self.assertIn("include auth_request.conf;", clips)
        review = block(clips, "location /clips/review/ {")
        self.assertIn("open_file_cache off;", review)


if __name__ == "__main__":
    unittest.main()
