"""Camera access on the event snapshot and thumbnail endpoints."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from frigate.models import Event
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_LIMITED = {"remote-user": "limited", "remote-role": "limited_user"}


class TestEventMediaCameraAccess(BaseTestHttp):
    def setUp(self):
        super().setUp([Event])
        self.minimal_config["auth"] = {"roles": {"limited_user": ["front_door"]}}
        self.minimal_config["cameras"]["back_door"] = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
        }
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _track(self, camera: str, event_id: str) -> MagicMock:
        """Make `event_id` an object currently tracked on `camera`."""
        tracked = MagicMock()
        tracked.get_img_bytes.return_value = (b"jpeg", 1.0)
        tracked.get_thumbnail.return_value = b"webp"
        self.app.detected_frames_processor = SimpleNamespace(
            camera_states={
                camera: SimpleNamespace(
                    name=camera,
                    tracked_objects={event_id: tracked},
                    camera_config=self.app.frigate_config.cameras[camera],
                )
            }
        )
        self.app.detected_frames_processor.get_camera_states = lambda: list(
            self.app.detected_frames_processor.camera_states.values()
        )
        return tracked

    def test_finished_event_snapshot_on_other_camera_is_forbidden(self):
        super().insert_mock_event("done1", camera="back_door")

        with AuthTestClient(self.app) as client:
            resp = client.get("/events/done1/snapshot.jpg", headers=_LIMITED)

        self.assertEqual(resp.status_code, 403)

    def test_tracked_snapshot_on_other_camera_is_forbidden_and_not_rendered(self):
        tracked = self._track("back_door", "live1")

        with AuthTestClient(self.app) as client:
            resp = client.get("/events/live1/snapshot.jpg", headers=_LIMITED)

        self.assertEqual(resp.status_code, 403)
        tracked.get_img_bytes.assert_not_called()

    def test_tracked_snapshot_on_allowed_camera_is_returned(self):
        self._track("front_door", "live1")

        with AuthTestClient(self.app) as client:
            resp = client.get("/events/live1/snapshot.jpg", headers=_LIMITED)

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content, b"jpeg")

    def test_tracked_thumbnail_on_other_camera_is_forbidden(self):
        tracked = self._track("back_door", "live1")

        with AuthTestClient(self.app) as client:
            resp = client.get("/events/live1/thumbnail.webp", headers=_LIMITED)

        self.assertEqual(resp.status_code, 403)
        tracked.get_thumbnail.assert_not_called()
