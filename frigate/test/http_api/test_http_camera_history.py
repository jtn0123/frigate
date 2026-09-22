"""HTTP coverage for camera history range and access boundaries (UI131)."""

import copy
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient

from frigate.api.auth import get_allowed_cameras_for_filter
from frigate.models import Event, Recordings, ReviewSegment
from frigate.stats.camera_history import CameraHistory
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}


class TestHttpCameraHistory(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.history = CameraHistory(Path(directory.name) / "history.json")
        self.history.record(
            {"cameras": {"front_door": {"camera_fps": 5}, "private": {"camera_fps": 0}}}
        )
        self.app = self.create_app()
        self.app.stats_emitter = SimpleNamespace(
            camera_history=self.history, get_latest_stats=lambda: {}
        )
        self.app.dependency_overrides[get_allowed_cameras_for_filter] = lambda: [
            "front_door"
        ]

    def test_admin_gets_all_history_even_when_filter_is_restricted(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/camera_history?range=6h")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["range"], "6h")
        self.assertEqual(set(response.json()["cameras"]), {"front_door", "private"})

    def test_viewer_only_sees_authorized_camera_without_mutating_store(self):
        payload = self.history.read("1h")
        original = copy.deepcopy(payload)
        self.app.stats_emitter.camera_history = SimpleNamespace(
            read=Mock(return_value=payload)
        )
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/camera_history?range=1h", headers=VIEWER)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()["cameras"]), {"front_door"})
        self.assertEqual(payload, original)

    def test_viewer_with_no_allowed_cameras_gets_empty_history(self):
        self.app.dependency_overrides[get_allowed_cameras_for_filter] = lambda: []
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/camera_history", headers=VIEWER)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["cameras"], {})

    def test_unknown_range_defaults_to_day(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/camera_history?range=invalid")
        self.assertEqual(response.json()["range"], "24h")

    def test_missing_collector_returns_empty_shape_for_requested_range(self):
        del self.app.stats_emitter.camera_history
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/camera_history?range=7d")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "range": "7d",
                "start": 0,
                "end": 0,
                "cell_seconds": 0,
                "bucket_seconds": 0,
                "cameras": {},
            },
        )

    def test_missing_collector_also_normalizes_invalid_range(self):
        self.app.stats_emitter.camera_history = None
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/camera_history?range=invalid")
        self.assertEqual(response.json()["range"], "24h")

    def test_anonymous_request_requires_authentication(self):
        with TestClient(self.app) as client:
            response = client.get("/fork/camera_history")
        self.assertEqual(response.status_code, 401)
