"""Exercise build-download transport flags against local HTTP and HTTPS servers."""

import http.server
import shlex
import ssl
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def download_options():
    """Read the transport options from the maintained download commands."""
    paths = [
        "docker/main/install_deps.sh",
        "docker/main/build_nginx.sh",
        "docker/main/build_intel_media_driver.sh",
        "docker/main/build_sqlite_vec.sh",
        "docker/main/build_pysqlite3.sh",
        "docker/main/install_s6_overlay.sh",
        "docker/main/install_tempio.sh",
        "docker/main/install_hailort.sh",
        "docker/main/install_memryx.sh",
        ".devcontainer/post_create.sh",
    ]
    commands = []
    for path in paths:
        source = (ROOT / path).read_text().replace("\\\n", " ")
        lines = source.splitlines()
        policy = next(
            (
                line.split("curl ", 1)[1].removesuffix(' "$@"')
                for line in lines
                if line.strip().startswith("curl ") and line.endswith(' "$@"')
            ),
            None,
        )
        for line in lines:
            command = line.strip()
            if command.startswith("wget "):
                raise AssertionError(
                    f"Download bypasses the curl transport policy: {path}"
                )
            if command.startswith("download_https "):
                if policy is None:
                    raise AssertionError(f"Missing HTTPS download policy: {path}")
                tokens = shlex.split(
                    policy + " " + command.removeprefix("download_https ")
                )
            elif command.startswith("curl ") and not command.endswith(' "$@"'):
                tokens = shlex.split(command.removeprefix("curl "))
            else:
                continue
            options = []
            for token in tokens:
                if token in (
                    "--output",
                    "--remote-name",
                    "--output-dir",
                ) or token.startswith("https://"):
                    break
                # Save test responses to stdout instead of the build's filesystem.
                options.append(token)
            commands.append((path, options))
    return commands


class DownloadHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        """Serve an artifact, error, or protocol-changing redirect."""
        self.server.requests.append(self.path)
        if self.path in ("/redirect", "/downgrade"):
            self.send_response(302)
            destination = (
                self.server.https_url
                if self.path == "/redirect"
                else self.server.http_url
            )
            self.send_header("Location", destination + "/artifact")
            self.end_headers()
        elif self.path == "/missing":
            self.send_error(404)
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"verified artifact")

    def log_message(self, *_args):
        """Keep test output limited to assertion failures."""


class TestDownloadSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.workspace.cleanup)
        root = Path(cls.workspace.name)
        cls.cert = root / "cert.pem"
        key = root / "key.pem"
        config = root / "cert.cnf"
        config.write_text(
            "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n"
            "[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\n"
        )
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                str(key),
                "-out",
                str(cls.cert),
                "-days",
                "1",
                "-config",
                str(config),
            ],
            check=True,
            capture_output=True,
        )
        cls.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DownloadHandler)
        cls.https = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DownloadHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cls.cert, key)
        cls.https.socket = context.wrap_socket(cls.https.socket, server_side=True)
        cls.http_url = f"http://localhost:{cls.http.server_port}"
        cls.https_url = f"https://localhost:{cls.https.server_port}"
        for server in (cls.http, cls.https):
            server.requests = []
            server.http_url = cls.http_url
            server.https_url = cls.https_url
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.addClassCleanup(server.server_close)
            cls.addClassCleanup(thread.join, 2)
            cls.addClassCleanup(server.shutdown)
        cls.commands = download_options()
        if not cls.commands:
            raise AssertionError("No download commands found")

    def run_download(self, options, url):
        """Run actual curl with source-derived options and a trusted test CA."""
        return subprocess.run(
            [
                "curl",
                "-q",
                *options,
                "--noproxy",
                "*",
                "--cacert",
                str(self.cert),
                "--max-time",
                "5",
                url,
            ],
            capture_output=True,
            timeout=10,
            cwd=self.workspace.name,
        )

    def test_https_downloads_and_redirects_preserve_artifact(self):
        for path, options in self.commands:
            for endpoint in ("/artifact", "/redirect"):
                with self.subTest(path=path, endpoint=endpoint, options=options):
                    result = self.run_download(options, self.https_url + endpoint)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout, b"verified artifact")

    def test_redirects_cannot_downgrade_to_http(self):
        for path, options in self.commands:
            with self.subTest(path=path, options=options):
                before = len(self.http.requests)
                result = self.run_download(options, self.https_url + "/downgrade")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.http.requests), before)
                self.assertNotIn(b"verified artifact", result.stdout)

    def test_initial_http_requests_are_blocked(self):
        for path, options in self.commands:
            with self.subTest(path=path, options=options):
                before = len(self.http.requests)
                result = self.run_download(options, self.http_url + "/artifact")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.http.requests), before)

    def test_http_errors_fail_instead_of_returning_an_installer(self):
        for path, options in self.commands:
            with self.subTest(path=path, options=options):
                result = self.run_download(options, self.https_url + "/missing")
                self.assertEqual(result.returncode, 22, result.stderr)
                self.assertEqual(result.stdout, b"")
