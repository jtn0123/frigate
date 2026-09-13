"""Security regression tests for configured camera destinations."""

import unittest
from ipaddress import ip_address
from unittest.mock import Mock, patch

from pydantic import ValidationError

from frigate.config.camera_discovery import CameraDiscoveryTarget
from frigate.util.camera_discovery import query_reolink


class TestCameraDestination(unittest.TestCase):
    def test_rejects_special_addresses(self):
        for address in (
            "127.0.0.1",
            "169.254.169.254",
            str(ip_address(0)),
            "224.0.0.1",
            "::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ):
            with self.subTest(address=address), self.assertRaises(ValidationError):
                CameraDiscoveryTarget(address=address)

    def test_rejects_invalid_ports(self):
        for port in (0, 65536):
            with self.subTest(port=port), self.assertRaises(ValidationError):
                CameraDiscoveryTarget(address="192.168.1.10", port=port)

    @patch("frigate.util.camera_discovery.HTTPSConnectionPool")
    def test_tls_uses_pinned_ip_and_verified_server_name(self, pool):
        target = CameraDiscoveryTarget(
            address="192.168.1.10", server_name="camera.local"
        )
        response = Mock(status=200)
        response.json.return_value = [{"Enc": {}}]
        pool.return_value.request.return_value = response
        self.assertEqual(
            query_reolink(target, "user", "pass&word"), (200, [{"Enc": {}}])
        )
        self.assertEqual(pool.call_args.args, ("192.168.1.10",))
        self.assertEqual(pool.call_args.kwargs["server_hostname"], "camera.local")
        self.assertEqual(pool.call_args.kwargs["assert_hostname"], "camera.local")
        self.assertEqual(pool.call_args.kwargs["cert_reqs"], "CERT_REQUIRED")
        request = pool.return_value.request
        self.assertFalse(request.call_args.kwargs["redirect"])
        self.assertFalse(request.call_args.kwargs["retries"])
        self.assertIn("password=pass%26word", request.call_args.args[1])

    @patch("frigate.util.camera_discovery.HTTPConnectionPool")
    def test_explicit_http_compatibility_does_not_follow_redirect(self, pool):
        target = CameraDiscoveryTarget(address="10.27.99.20", scheme="http")
        response = Mock(status=302)
        pool.return_value.request.return_value = response
        self.assertEqual(query_reolink(target, "user", "password"), (302, None))
        response.json.assert_not_called()
        self.assertEqual(pool.call_args.kwargs["port"], 80)

    def test_tls_is_default_and_server_name_cannot_inject_headers(self):
        self.assertEqual(CameraDiscoveryTarget(address="192.168.1.10").scheme, "https")
        for name in ("camera\r\nInjected: yes", "camera/path", "user@camera"):
            with self.subTest(name=name), self.assertRaises(ValidationError):
                CameraDiscoveryTarget(address="192.168.1.10", server_name=name)


class TestCameraHttpsConnection(unittest.TestCase):
    """Exercise certificate validation and connection pinning on real sockets."""

    @classmethod
    def setUpClass(cls):
        import ssl
        import subprocess
        import tempfile
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from pathlib import Path

        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name)
        cls.certificate = root / "cert.pem"
        key = root / "key.pem"
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
                str(cls.certificate),
                "-days",
                "1",
                "-subj",
                "/CN=camera.test",
                "-addext",
                "subjectAltName=DNS:camera.test",
            ],
            check=True,
            capture_output=True,
        )
        cls.requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.requests.append((self.path, self.headers["Host"]))
                self.send_response(cls.response_status)
                self.send_header("Location", "http://127.0.0.1:1/forbidden")
                self.end_headers()
                self.wfile.write(b'[{"Enc": {}}]')

            def log_message(self, *_args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.addClassCleanup(cls.server.server_close)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cls.certificate, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.thread.join)
        cls.addClassCleanup(cls.server.shutdown)

    def setUp(self):
        self.requests.clear()
        type(self).response_status = 200
        # Only the test fixture bypasses the production loopback prohibition.
        self.target = CameraDiscoveryTarget.model_construct(
            address=ip_address("127.0.0.1"),
            port=self.server.server_port,
            server_name="camera.test",
            ca_certs=str(self.certificate),
            scheme="https",
        )

    def test_connects_to_pinned_ip_with_verified_certificate_and_no_proxy(self):
        with patch.dict("os.environ", {"HTTPS_PROXY": "http://127.0.0.1:1"}):
            self.assertEqual(
                query_reolink(self.target, "user", "secret&value"), (200, [{"Enc": {}}])
            )
        self.assertEqual(len(self.requests), 1)
        self.assertIn("password=secret%26value", self.requests[0][0])
        self.assertEqual(self.requests[0][1], f"camera.test:{self.server.server_port}")

    def test_rejects_untrusted_certificate_before_sending_credentials(self):
        from urllib3.exceptions import SSLError

        self.target.ca_certs = None
        with self.assertRaises(SSLError):
            query_reolink(self.target, "user", "secret")
        self.assertEqual(self.requests, [])

    def test_rejects_wrong_hostname_before_sending_credentials(self):
        from urllib3.exceptions import SSLError

        self.target.server_name = "other-camera.test"
        with self.assertRaises(SSLError):
            query_reolink(self.target, "user", "secret")
        self.assertEqual(self.requests, [])

    def test_redirect_does_not_retarget_connection(self):
        type(self).response_status = 302
        self.assertEqual(query_reolink(self.target, "user", "secret"), (302, None))
        self.assertEqual(len(self.requests), 1)
