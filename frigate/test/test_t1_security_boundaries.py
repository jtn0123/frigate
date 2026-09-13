"""Regression checks for camera redirects and nonsecurity model identifiers."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate.api.camera import reolink_detect
from frigate.detectors.detector_config import ModelConfig
from frigate.ptz.autotrack import ptz_moving_at_frame_time
from frigate.util.services import get_bandwidth_stats


class TestCameraRedirects(unittest.TestCase):
    """Camera discovery must stay on the administrator-selected host."""

    @patch("frigate.api.camera.requests.get")
    def test_redirect_is_not_followed_or_parsed(self, get):
        get.return_value = Mock(status_code=302)
        response = reolink_detect("camera.local", "user", "pass&word")
        self.assertFalse(json.loads(response.body)["success"])
        self.assertEqual(get.call_args.kwargs["allow_redirects"], False)
        get.return_value.json.assert_not_called()
        self.assertIn("password=pass%26word", get.call_args.args[0])

    @patch("frigate.api.camera.requests.get")
    def test_successful_camera_response_is_still_parsed(self, get):
        get.return_value = Mock(status_code=200)
        get.return_value.json.return_value = [
            {"value": {"Enc": {"mainStream": {"width": 1920, "height": 1080}}}}
        ]
        response = reolink_detect("camera.local", "user", "password")
        self.assertTrue(json.loads(response.body)["success"])


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
