"""nginx keeps public clip share reads limited, masked in logs, and GET-only."""

import re
import unittest
from pathlib import Path

CONF = (
    Path(__file__).resolve().parents[2]
    / "docker/main/rootfs/usr/local/nginx/conf/nginx.conf"
)
SHARE_ID = "abcDEF_1234567890-token"


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


def map_regex(text: str, variable: str) -> re.Pattern:
    """Compile the single regex entry of `map ... $variable`."""
    body = block(text, f"{variable} {{")
    pattern = re.search(r"^\s*~(\S+)\s", body, re.MULTILINE).group(1)
    # PCRE named groups to Python's spelling
    return re.compile(pattern.replace("(?<", "(?P<"))


class TestNginxShareConf(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conf = CONF.read_text()
        cls.public = block(cls.conf, "location ~ ^/api/fork/share/[^/]+ {")
        cls.authed = block(cls.conf, "location @fork_share_authed {")

    def test_limit_zones_are_defined_in_the_http_block(self):
        http = self.conf[self.conf.index("http {") : self.conf.index("server {")]
        self.assertIn(
            "limit_req_zone $fork_share_token zone=fork_share:1m rate=5r/s;", http
        )
        self.assertIn(
            "limit_conn_zone $fork_share_token zone=fork_share_conn:1m;", http
        )

    def test_strict_zones_are_not_keyed_on_the_client_address(self):
        # behind a proxy every viewer has one address, so one bucket (E20)
        for zone in ("fork_share", "fork_share_conn"):
            key = re.search(rf"limit_\w+_zone (\S+) zone={zone}:", self.conf).group(1)
            self.assertEqual(key, "$fork_share_token", zone)

    def test_address_zones_are_a_second_looser_limit(self):
        http = self.conf[self.conf.index("http {") : self.conf.index("server {")]
        rate = re.search(
            r"limit_req_zone \$binary_remote_addr zone=fork_share_addr:1m "
            r"rate=(\d+)r/s;",
            http,
        )
        self.assertIsNotNone(rate)
        self.assertGreater(int(rate.group(1)), 5)
        self.assertIn(
            "limit_conn_zone $binary_remote_addr zone=fork_share_addr_conn:1m;", http
        )
        token_conns = re.search(r"limit_conn fork_share_conn (\d+);", self.public)
        addr_conns = re.search(r"limit_conn fork_share_addr_conn (\d+);", self.public)
        self.assertGreater(int(addr_conns.group(1)), int(token_conns.group(1)))

    def test_share_token_key_is_the_token_segment(self):
        self.assertIn("map $uri $fork_share_token {", self.conf)
        body = block(self.conf, "$fork_share_token {")
        self.assertIn(" $fork_share_segment;", body)
        self.assertRegex(body, r'default "";')
        token = map_regex(self.conf, "$fork_share_token")
        # the limits run after the location's rewrite took /api off $uri
        for uri in (
            f"/api/fork/share/{SHARE_ID}",
            f"/api/fork/share/{SHARE_ID}/clip.mp4",
            f"/fork/share/{SHARE_ID}",
            f"/fork/share/{SHARE_ID}/clip.mp4",
        ):
            match = token.search(uri)
            self.assertIsNotNone(match, uri)
            self.assertEqual(match["fork_share_segment"], SHARE_ID)
        for uri in (
            "/api/fork/share",
            "/api/fork/share/",
            "/api/config",
            "/x/fork/share/a",
        ):
            self.assertIsNone(token.search(uri), uri)

    def test_two_tokens_get_two_buckets(self):
        token = map_regex(self.conf, "$fork_share_token")
        first = token.search(f"/fork/share/{SHARE_ID}/clip.mp4")
        second = token.search(f"/fork/share/other-{SHARE_ID}/clip.mp4")
        self.assertNotEqual(first["fork_share_segment"], second["fork_share_segment"])

    def test_public_location_is_rate_limited_with_429(self):
        self.assertIn("limit_req zone=fork_share burst=10 nodelay;", self.public)
        self.assertRegex(
            self.public, r"limit_req zone=fork_share_addr burst=\d+ nodelay;"
        )
        self.assertIn("limit_req_status 429;", self.public)
        self.assertIn("limit_conn fork_share_conn ", self.public)
        self.assertIn("limit_conn fork_share_addr_conn ", self.public)
        self.assertIn("limit_conn_status 429;", self.public)

    def test_limit_refusals_stay_out_of_the_error_log(self):
        # error_log is "warn" and its lines carry the request line with the token
        self.assertIn("error_log /dev/stdout warn;", self.conf)
        self.assertIn("limit_req_log_level info;", self.public)
        self.assertIn("limit_conn_log_level info;", self.public)

    def test_only_get_and_head_skip_auth(self):
        self.assertIn("auth_request off;", self.public)
        self.assertIn("error_page 418 = @fork_share_authed;", self.public)
        self.assertRegex(
            self.public,
            r"if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{\s*return 418;\s*\}",
        )
        self.assertIn("include auth_request.conf;", self.authed)
        self.assertNotIn("auth_request off;", self.authed)

    def test_public_location_drops_client_identity_headers(self):
        self.assertIn('proxy_set_header Remote-User "";', self.public)
        self.assertIn('proxy_set_header Remote-Role "";', self.public)

    def test_list_and_create_do_not_match_the_public_location(self):
        header = re.search(r"location ~ (\S+) \{\n\s+error_page 418", self.conf)
        public = re.compile(header.group(1))
        self.assertIsNone(public.search("/api/fork/share"))
        self.assertIsNone(public.search("/api/fork/share/"))
        self.assertIsNotNone(public.search(f"/api/fork/share/{SHARE_ID}"))
        self.assertIsNotNone(public.search(f"/api/fork/share/{SHARE_ID}/clip.mp4"))

    def test_share_requests_use_the_masked_log_format(self):
        self.assertIn("access_log /dev/stdout main if=$is_not_share_uri;", self.conf)
        self.assertIn(
            "access_log /dev/stdout share_masked if=$is_share_uri;", self.conf
        )
        start = self.conf.index("log_format share_masked")
        masked = self.conf[start : self.conf.index("access_log /dev/stdout main")]
        self.assertIn('"$request_method $loggable_uri $server_protocol"', masked)
        self.assertNotIn("$request ", masked)
        self.assertNotIn("$request_uri", masked)
        self.assertNotIn('"$http_referer"', self.conf)

    def test_share_uri_detection(self):
        is_share = map_regex(self.conf, "$is_share_uri")
        for uri in (
            f"/api/fork/share/{SHARE_ID}",
            f"/api/fork/share/{SHARE_ID}/clip.mp4",
            f"/share/{SHARE_ID}",
            f"/share/{SHARE_ID}?x=1",
        ):
            self.assertIsNotNone(is_share.search(uri), uri)
        for uri in ("/api/fork/share", "/api/config", "/shared", "/api/events"):
            self.assertIsNone(is_share.search(uri), uri)

    def test_token_is_masked_in_the_request_uri(self):
        loggable = map_regex(self.conf, "$loggable_uri")
        for uri, expected in (
            (f"/api/fork/share/{SHARE_ID}", "/api/fork/share/<redacted>"),
            (
                f"/api/fork/share/{SHARE_ID}/clip.mp4",
                "/api/fork/share/<redacted>/clip.mp4",
            ),
            (f"/share/{SHARE_ID}?x=1", "/share/<redacted>?x=1"),
        ):
            match = loggable.search(uri)
            masked = f"{match['share_prefix']}<redacted>{match['share_rest']}"
            self.assertEqual(masked, expected)
            self.assertNotIn(SHARE_ID, masked)

    def test_token_is_masked_in_the_referer(self):
        loggable = map_regex(self.conf, "$loggable_referer")
        match = loggable.search(f"https://nvr.example/share/{SHARE_ID}")
        self.assertEqual(
            f"{match['referer_prefix']}<redacted>{match['referer_rest']}",
            "https://nvr.example/share/<redacted>",
        )
        self.assertIsNone(loggable.search("https://nvr.example/review"))


if __name__ == "__main__":
    unittest.main()
