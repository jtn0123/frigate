"""Regression checks for camera redirects and nonsecurity model identifiers."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate.api.camera import reolink_detect
from frigate.config.camera_discovery import CameraDiscoveryTarget
from frigate.detectors.detector_config import ModelConfig
from frigate.ptz.autotrack import ptz_moving_at_frame_time
from frigate.util.services import get_bandwidth_stats


class TestCameraRedirects(unittest.TestCase):
    """Camera discovery must stay on the administrator-selected host."""

    def setUp(self):
        self.target = CameraDiscoveryTarget(address="192.168.1.10")
        self.request = SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=SimpleNamespace(
                    networking=SimpleNamespace(
                        reolink_targets={"camera.local": self.target}
                    )
                )
            )
        )

    @patch("frigate.api.camera.query_reolink", return_value=(302, None))
    def test_redirect_is_not_followed_or_parsed(self, query):
        response = reolink_detect(self.request, "camera.local", "user", "pass&word")
        self.assertFalse(json.loads(response.body)["success"])
        query.assert_called_once_with(self.target, "user", "pass&word")

    @patch("frigate.api.camera.query_reolink")
    def test_successful_camera_response_is_still_parsed(self, query):
        query.return_value = (
            200,
            [{"value": {"Enc": {"mainStream": {"width": 1920, "height": 1080}}}}],
        )
        response = reolink_detect(self.request, "camera.local", "user", "password")
        self.assertTrue(json.loads(response.body)["success"])

    @patch("frigate.api.camera.query_reolink")
    def test_malformed_camera_payload_is_a_safe_failure(self, query):
        for data in ({"value": None}, {"Enc": [1]}, {"Enc": {"mainStream": 1}}):
            with self.subTest(data=data):
                query.return_value = (200, data)
                response = reolink_detect(
                    self.request, "camera.local", "user", "secret"
                )
                self.assertFalse(json.loads(response.body)["success"])
                self.assertNotIn("secret", response.body.decode())

    @patch("frigate.api.camera.query_reolink")
    def test_transport_and_json_errors_are_safe_failures(self, query):
        from urllib3.exceptions import HTTPError, TimeoutError

        for error in (
            HTTPError("secret"),
            TimeoutError("secret"),
            ValueError("secret"),
        ):
            with self.subTest(error=type(error)):
                query.side_effect = error
                response = reolink_detect(
                    self.request, "camera.local", "user", "secret"
                )
                self.assertFalse(json.loads(response.body)["success"])
                self.assertNotIn("secret", response.body.decode())

    @patch("frigate.api.camera.query_reolink")
    def test_unlisted_destinations_cannot_make_requests(self, query):
        for host in (
            "127.0.0.1",
            "169.254.169.254",
            "other-camera.local",
            "camera.local:9000",
        ):
            with self.subTest(host=host):
                response = reolink_detect(self.request, host, "user", "password")
                self.assertEqual(response.status_code, 403)
        query.assert_not_called()

    @patch("frigate.api.camera.query_reolink")
    def test_host_suffix_cannot_inject_url_components(self, get):
        for host in (
            "camera:80@other-host",
            "camera:80/path",
            "camera:80?cmd=Other",
            "camera:80#fragment",
            "camera:80\\other",
            "camera:80\n",
            "camera:0",
            "camera:65536",
            "camera:invalid",
            "camera:80:90",
            "camera:٨٠",
            "camera:８０",
        ):
            with self.subTest(host=host):
                response = reolink_detect(self.request, host, "user", "password")
                self.assertEqual(response.status_code, 400)
        get.assert_not_called()

    def test_lan_hostnames_and_valid_ports_remain_supported(self):
        from frigate.api.camera import _is_valid_host

        for host in (
            "192.168.1.10",
            "camera.local",
            "camera-1",
            "camera:8080",
            "camera.local.",
        ):
            with self.subTest(host=host):
                self.assertTrue(_is_valid_host(host))

    @patch("frigate.api.camera.query_reolink")
    def test_discovery_requires_admin_role(self, get):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from frigate.api.camera import router

        app = FastAPI()
        setattr(
            app,
            "frigate_config",
            SimpleNamespace(
                proxy=SimpleNamespace(separator=","),
                auth=SimpleNamespace(roles={"admin": [], "viewer": []}),
            ),
        )
        app.include_router(router)
        with TestClient(app) as client:
            for headers in ({}, {"remote-role": "viewer"}):
                response = client.get(
                    "/reolink/detect",
                    params={
                        "host": "camera.local",
                        "username": "user",
                        "password": "password",
                    },
                    headers=headers,
                )
                self.assertEqual(response.status_code, 403)
        get.assert_not_called()

    @patch("frigate.api.camera.requests.get")
    def test_admin_cannot_probe_an_unconfigured_destination(self, get):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from frigate.api.camera import router

        get.return_value = Mock(status_code=200)
        get.return_value.json.return_value = [
            {"value": {"Enc": {"mainStream": {"width": 1920, "height": 1080}}}}
        ]
        app = FastAPI()
        app.frigate_config = SimpleNamespace(
            proxy=SimpleNamespace(separator=","),
            auth=SimpleNamespace(roles={"admin": []}),
            networking=SimpleNamespace(reolink_targets={}),
        )
        app.include_router(router)
        with TestClient(app) as client:
            response = client.get(
                "/reolink/detect",
                params={
                    "host": "127.0.0.1",
                    "username": "user",
                    "password": "password",
                },
                headers={"remote-role": "admin"},
            )
        self.assertEqual(response.status_code, 403)
        get.assert_not_called()


class TestModelIdentifier(unittest.TestCase):
    """The historical model identifier must retain exact compatibility."""

    def test_model_identifier(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model"
            path.write_bytes(b"abc")
            model = ModelConfig(path=str(path))
            model.compute_model_hash()
            self.assertEqual(model.model_hash, "900150983cd24fb0d6963f7d28e17f72")

    def test_missing_model_identifier(self):
        model = ModelConfig(path=None)
        model.compute_model_hash()
        self.assertEqual(model.model_hash, "ad921d60486366258809553a3db49a4a")


class TestPtzSentinel(unittest.TestCase):
    """Exact zero is an unset timestamp, not an approximate measurement."""

    def test_unset_and_small_nonzero_timestamps(self):
        self.assertFalse(ptz_moving_at_frame_time(1, 0.0, 0.0))
        self.assertTrue(ptz_moving_at_frame_time(2e-12, 1e-12, 0.0))
        self.assertFalse(ptz_moving_at_frame_time(3e-12, 1e-12, 2e-12))


class TestBandwidthProcessNames(unittest.TestCase):
    """Only the supported nethogs process forms should contribute usage."""

    @patch("frigate.util.services.get_physical_interfaces", return_value=[])
    @patch("frigate.util.services.sp.run")
    def test_process_alternatives(self, run, _interfaces):
        run.return_value = Mock(
            returncode=0,
            stdout="\n".join(
                [
                    "ffmpeg/11/1000\t1\t2",
                    "/usr/local/go2rtc/12/1000\t2\t3",
                    "frigate.detector.cpu/13/1000\t3\t4",
                    "notffmpeg/14/1000\t1\t1",
                    "unrelated/15/1000\t1\t1",
                    "ffmpeg/16/1000\tinvalid\t1",
                ]
            ),
        )
        config = SimpleNamespace(telemetry=SimpleNamespace(network_interfaces=[]))
        self.assertEqual(
            get_bandwidth_stats(config),
            {
                "11": {"bandwidth": 3.0},
                "12": {"bandwidth": 5.0},
                "13": {"bandwidth": 7.0},
            },
        )
