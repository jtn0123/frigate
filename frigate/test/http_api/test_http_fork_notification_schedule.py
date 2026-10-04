"""HTTP tests for the notification quiet hours state (fork D78)."""

import copy
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from frigate.fork import notification_schedule as schedule
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}
URL = "/fork/notifications/schedule"


class TestHttpForkNotificationSchedule(BaseTestHttp):
    def create_app(self, *args, **kwargs):
        app = super().create_app(*args, **kwargs)
        # The app's model sampler reads stats in the background.
        app.stats_emitter = SimpleNamespace(get_latest_stats=lambda: {})
        return app

    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        camera = self.minimal_config["cameras"]["front_door"]
        self.minimal_config["notifications"] = {
            "enabled": True,
            # equal start and end: a full day, every day
            "quiet_hours": [{"start": "00:00", "end": "00:00"}],
        }
        backyard = copy.deepcopy(camera)
        backyard["ffmpeg"]["inputs"][0]["path"] = "rtsp://10.0.0.2:554/video"
        backyard["notifications"] = {"quiet_hours": []}
        self.minimal_config["cameras"]["backyard"] = backyard

    def test_state_per_camera_on_the_ui_timezone(self):
        self.minimal_config["ui"] = {"timezone": "America/Chicago"}
        app = self.create_app()

        with AuthTestClient(app) as client:
            response = client.get(URL)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["timezone"], "America/Chicago")
        self.assertEqual(body["source"], "ui")
        self.assertGreater(body["now"], 0)
        self.assertEqual(
            body["cameras"],
            {
                "front_door": {"quiet": True, "windows": 1},
                "backyard": {"quiet": False, "windows": 0},
            },
        )

    @patch.object(schedule, "get_localzone", return_value=ZoneInfo("Europe/Berlin"))
    def test_server_time_without_a_ui_timezone(self, _local):
        app = self.create_app()

        with AuthTestClient(app) as client:
            body = client.get(URL).json()

        self.assertEqual(
            (body["timezone"], body["source"]), ("Europe/Berlin", "server")
        )

    def test_admin_only(self):
        app = self.create_app()

        with AuthTestClient(app) as client:
            viewer = client.get(URL, headers=VIEWER)
            anonymous = client.get(
                URL, headers={"remote-user": "anonymous", "remote-role": "viewer"}
            )

        self.assertEqual(viewer.status_code, 403)
        self.assertIn(anonymous.status_code, (401, 403))
