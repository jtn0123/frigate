"""HTTP coverage for go2rtc source state and its access boundaries (I57)."""

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from requests.exceptions import ConnectionError as RequestsConnectionError

from frigate.api.auth import get_allowed_cameras_for_filter
from frigate.api.fork_go2rtc_state import get_reader
from frigate.fork.go2rtc_state import Go2rtcStateReader
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}

# Every string here must stay out of every response.
FORBIDDEN = (
    "hunter2",
    "s3cret",
    "tok123",
    "camuser",
    "password",
    "token",
    "Streaming",
    "subtype",
    "@",
    "?",
)

GO2RTC_STREAMS: dict[str, Any] = {
    "front_door": {
        "producers": [
            {
                "id": 1,
                "format_name": "rtsp",
                "remote_addr": "10.0.0.1:554",
                "url": "rtsp://camuser:hunter2@10.0.0.1:554/Streaming/Channels/101?token=tok123",
                "medias": ["video, recvonly, H264 High 4.1", "audio, recvonly, PCMA"],
                "bytes_recv": 4096,
            }
        ],
        "consumers": [{"id": 2, "bytes_send": 4000}],
    },
    "private_main": {
        "producers": [
            {
                "url": "ffmpeg:http://10.0.0.2/flv?user=camuser&password=s3cret#video=copy"
            }
        ],
        "consumers": None,
    },
    "unowned": {"producers": [{"url": "rtsp://camuser:hunter2@10.0.0.3/1"}]},
}


class TestHttpForkGo2rtcState(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        self.minimal_config["go2rtc"] = {
            "streams": {
                "front_door": [
                    "rtsp://camuser:hunter2@10.0.0.1:554/Streaming/Channels/101?token=tok123"
                ],
                "private_main": [
                    "ffmpeg:http://10.0.0.2/flv?user=camuser&password=s3cret#video=copy"
                ],
                "private_sub": [
                    "rtsp://camuser:hunter2@10.0.0.2:554/cam?subtype=1&token=tok123"
                ],
            }
        }
        self.minimal_config["cameras"]["front_door"]["ffmpeg"]["inputs"][0]["path"] = (
            "rtsp://127.0.0.1:8554/front_door"
        )
        self.minimal_config["cameras"]["private"] = {
            "ffmpeg": {
                "inputs": [
                    {"path": "rtsp://127.0.0.1:8554/private_sub", "roles": ["detect"]}
                ]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
            "live": {"streams": {"Main": "private_main"}},
        }
        self.app = self.create_app()
        # The app's model sampler reads stats in the background.
        self.app.stats_emitter = SimpleNamespace(get_latest_stats=lambda: {})
        self.fetch = Mock(return_value=GO2RTC_STREAMS)
        self.app.state.fork_go2rtc_state = Go2rtcStateReader(fetch=self.fetch)
        self.app.dependency_overrides[get_allowed_cameras_for_filter] = lambda: [
            "front_door"
        ]

    def assert_no_secret(self, response) -> None:
        for forbidden in FORBIDDEN:
            self.assertNotIn(forbidden, response.text)

    def test_admin_sees_every_camera_even_when_filter_is_restricted(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/go2rtc_state")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["available"])
        self.assertGreater(body["updated"], 0)
        self.assertEqual(set(body["cameras"]), {"front_door", "private"})
        self.assertEqual(
            body["cameras"]["front_door"]["streams"],
            [
                {
                    "name": "front_door",
                    "configured": True,
                    "connected": True,
                    "bytes_received": 4096,
                    "bytes_per_second": None,
                    "producers": 1,
                    "consumers": 1,
                    "codecs": ["H264", "PCMA"],
                    "source": "rtsp://10.0.0.1:554",
                }
            ],
        )
        main, sub = body["cameras"]["private"]["streams"]
        self.assertEqual(
            (main["name"], main["configured"], main["connected"], main["source"]),
            ("private_main", True, False, "ffmpeg:http://10.0.0.2"),
        )
        # Named by the ffmpeg input and in the config, but go2rtc lacks it.
        self.assertEqual(
            (sub["name"], sub["configured"], sub["connected"], sub["source"]),
            ("private_sub", False, False, "rtsp://10.0.0.2:554"),
        )
        self.assert_no_secret(response)

    def test_viewer_only_sees_allowed_cameras(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/go2rtc_state", headers=VIEWER)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()["cameras"]), {"front_door"})
        self.assertNotIn("private", response.text)
        self.assertNotIn("unowned", response.text)
        self.assertNotIn("10.0.0.2", response.text)
        self.assert_no_secret(response)

    def test_viewer_with_no_allowed_cameras_gets_no_streams(self):
        self.app.dependency_overrides[get_allowed_cameras_for_filter] = lambda: []
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/go2rtc_state", headers=VIEWER)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["available"])
        self.assertEqual(response.json()["cameras"], {})

    def test_go2rtc_down_is_unavailable_not_an_error(self):
        del self.app.state.fork_go2rtc_state
        with (
            patch(
                "frigate.fork.go2rtc_state.requests.get",
                side_effect=RequestsConnectionError("refused"),
            ) as get,
            AuthTestClient(self.app) as client,
        ):
            response = client.get("/fork/go2rtc_state")
            again = client.get("/fork/go2rtc_state")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["available"])
        self.assertEqual(body["cameras"], {})
        # The second request is served from the reader's cache.
        self.assertEqual(again.json(), body)
        get.assert_called_once()
        self.assertIsInstance(get_reader(self.app), Go2rtcStateReader)

    def test_requests_within_the_cache_window_share_one_fetch(self):
        with AuthTestClient(self.app) as client:
            first = client.get("/fork/go2rtc_state")
            second = client.get("/fork/go2rtc_state", headers=VIEWER)
        self.assertEqual(first.json()["updated"], second.json()["updated"])
        self.fetch.assert_called_once()

    def test_receive_rate_appears_on_the_second_sample(self):
        now = [100.0]
        later = json.loads(json.dumps(GO2RTC_STREAMS))
        later["front_door"]["producers"][0]["bytes_recv"] = 4096 + 60_000
        self.fetch.side_effect = [GO2RTC_STREAMS, later]
        self.app.state.fork_go2rtc_state = Go2rtcStateReader(
            fetch=self.fetch, clock=lambda: now[0]
        )
        with AuthTestClient(self.app) as client:
            client.get("/fork/go2rtc_state")
            now[0] += 30
            response = client.get("/fork/go2rtc_state")
        stream = response.json()["cameras"]["front_door"]["streams"][0]
        self.assertEqual(stream["bytes_per_second"], 2000.0)
        self.assert_no_secret(response)

    def test_anonymous_request_requires_authentication(self):
        with TestClient(self.app) as client:
            response = client.get("/fork/go2rtc_state")
        self.assertEqual(response.status_code, 401)
        self.fetch.assert_not_called()
