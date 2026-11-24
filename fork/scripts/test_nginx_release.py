"""The image builds an nginx release without the HTTP/2 vulnerabilities (E37)."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "docker/main/build_nginx.sh"

# CVE-2026-123007 (HTTP/2 flow control heap overflow) and CVE-2026-123633
# (HTTP/2 use-after-free) are fixed in 1.30.7, the release upstream 0.18.3 ships
FIXED = (1, 30, 7)


def assignment(text: str, name: str) -> str:
    """The value of a NAME="value" line in the build script."""
    match = re.search(rf'^{name}="([^"]*)"$', text, re.MULTILINE)
    if match is None:
        raise AssertionError(f"{name} is not assigned")
    return match.group(1)


class TestNginxRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = BUILD.read_text()

    def test_the_built_release_has_the_http2_fixes(self):
        version = tuple(
            int(part) for part in assignment(self.build, "NGINX_VERSION").split(".")
        )
        self.assertGreaterEqual(version, FIXED)

    def test_the_tarball_is_checked_before_it_is_unpacked(self):
        digest = assignment(self.build, "NGINX_SHA256")
        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        lines = self.build.splitlines()
        download = next(
            i for i, line in enumerate(lines) if "nginx.org/download/" in line
        )
        unpack = next(
            i for i, line in enumerate(lines) if line.startswith("tar -zxf nginx-")
        )
        check = next(i for i, line in enumerate(lines) if "sha256sum -c" in line)
        self.assertLess(download, check)
        self.assertLess(check, unpack)
        self.assertIn("${NGINX_SHA256}  nginx-${NGINX_VERSION}.tar.gz", lines[check])


if __name__ == "__main__":
    unittest.main()
