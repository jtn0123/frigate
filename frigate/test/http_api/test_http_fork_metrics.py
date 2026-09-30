"""HTTP coverage for the fork's Prometheus metrics on `/metrics` (I59)."""

from types import SimpleNamespace
from unittest.mock import Mock

from frigate.fork.go2rtc_state import Go2rtcStateReader
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}
SOURCE = "rtsp://camuser:hunter2@10.0.0.1:554/Streaming/Channels/101?token=tok123"
STATS = {
    "cameras": {
        "front_door": {
            "camera_fps": 0.0,
            "expected_fps": 5,
            "outage_since": 1_790_000_000.0,
            "restarts_24h": 4,
            "watchdog_age": 2.0,
        }
    },
    "service": {"last_updated": 1_790_000_600},
}
HISTORY = {
    "range": "24h",
    "cameras": {"front_door": {"uptime": 50.0, "samples": 10}},
}


class TestHttpForkMetrics(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        self.minimal_config["go2rtc"] = {"streams": {"front_door": [SOURCE]}}
        self.app = self.create_app()
        self.read_history = Mock(return_value=HISTORY)
        self.app.stats_emitter = SimpleNamespace(
            get_latest_stats=lambda: STATS,
            camera_history=SimpleNamespace(read=self.read_history),
        )
        self.fetch = Mock(
            return_value={
                "front_door": {
                    "producers": [{"url": SOURCE, "bytes_recv": 4096, "medias": ["v"]}],
                    "consumers": [{"id": 1}],
                }
            }
        )
        self.app.state.fork_go2rtc_state = Go2rtcStateReader(fetch=self.fetch)

    def test_admin_scrape_includes_the_fork_metrics(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        text = response.text
        self.assertIn('frigate_camera_up{camera_name="front_door"} 0.0', text)
        self.assertIn(
            'frigate_camera_outage_seconds{camera_name="front_door"} 600.0', text
        )
        self.assertIn('frigate_camera_restarts_24h{camera_name="front_door"} 4.0', text)
        self.assertIn(
            'frigate_camera_uptime_ratio{camera_name="front_door",window="24h"} 0.5',
            text,
        )
        self.assertIn("frigate_go2rtc_available 1.0", text)
        self.assertIn(
            'frigate_go2rtc_stream_connected{camera_name="front_door",'
            'stream="front_door"} 1.0',
            text,
        )
        self.read_history.assert_called_once_with("24h")
        # upstream's metrics are still there
        self.assertIn("frigate_camera_fps", text)

    def test_scrape_includes_the_last_camera_ping(self):
        self.app.state.fork_camera_ping = {
            "front_door": {"reachable": True, "ms": 8.0, "loss": 0.0, "method": "icmp"}
        }

        with AuthTestClient(self.app) as client:
            text = client.get("/metrics").text

        self.assertIn('frigate_camera_ping_up{camera_name="front_door"} 1.0', text)
        self.assertIn(
            'frigate_camera_ping_seconds{camera_name="front_door"} 0.008', text
        )

    def test_emitter_without_camera_history_still_scrapes(self):
        self.app.stats_emitter = SimpleNamespace(get_latest_stats=lambda: STATS)

        with AuthTestClient(self.app) as client:
            response = client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        self.assertIn("frigate_camera_up", response.text)
        self.assertNotIn("frigate_camera_uptime_ratio", response.text)

    def test_no_camera_credentials_in_a_scrape(self):
        with AuthTestClient(self.app) as client:
            text = client.get("/metrics").text

        for forbidden in ("hunter2", "camuser", "tok123", "Streaming"):
            self.assertNotIn(forbidden, text)

    def test_go2rtc_down_does_not_fail_the_scrape(self):
        self.app.state.fork_go2rtc_state = Go2rtcStateReader(
            fetch=Mock(return_value=None)
        )

        with AuthTestClient(self.app) as client:
            response = client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        self.assertIn("frigate_go2rtc_available 0.0", response.text)
        self.assertNotIn("frigate_go2rtc_stream_connected", response.text)

    def test_viewer_cannot_scrape(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/metrics", headers=VIEWER)

        self.assertEqual(response.status_code, 403)
        self.fetch.assert_not_called()
