"""nginx passes vod playlist query args on without the secure token module."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONF = ROOT / "docker/main/rootfs/usr/local/nginx/conf/nginx.conf"
BUILD = ROOT / "docker/main/build_nginx.sh"


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


class TestNginxVodArgs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vod = block(CONF.read_text(), "location /vod/ {")
        cls.build = BUILD.read_text()

    def test_the_deleted_module_is_not_built(self):
        # kaltura/nginx-secure-token-module was removed from GitHub, so a
        # build without a cache failed downloading it (upstream #24893)
        self.assertNotIn("secure-token", self.build)
        self.assertNotIn("SECURE_TOKEN", self.build)
        self.assertNotIn("secure_token", self.vod)

    def test_playlist_urls_keep_the_query_args(self):
        # Home Assistant signs vod playlists with an authSig query arg that
        # every segment and init URL inside the playlist must carry too
        self.assertIn("sub_filter_types application/vnd.apple.mpegurl;", self.vod)
        self.assertIn("sub_filter_once off;", self.vod)
        for ending in ("'.m3u8' '.m3u8$is_args$args'", "'.m4s' '.m4s$is_args$args'"):
            self.assertIn(f"sub_filter {ending};", self.vod)
        self.assertIn("""sub_filter '.mp4"' '.mp4$is_args$args"';""", self.vod)

    def test_the_sub_module_stays_compiled_in(self):
        self.assertIn("--with-http_sub_module", self.build)


if __name__ == "__main__":
    unittest.main()
