"""HTTP coverage for the collapsed log summary (I58): admin only, validated."""

import os
import tempfile
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from frigate.api import fork_log_summary
from frigate.fork import log_summary
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}
LEAK_MARKER = "hunter2Secret"


def _stamp(when: datetime) -> str:
    return when.strftime("%Y-%m-%d %H:%M:%S")


class TestHttpForkLogSummary(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.paths = {
            "frigate": os.path.join(directory.name, "frigate"),
            "go2rtc": os.path.join(directory.name, "go2rtc"),
        }
        paths = patch.object(log_summary, "LOG_PATHS", self.paths)
        paths.start()
        self.addCleanup(paths.stop)
        fork_log_summary.clear_cache()
        self.addCleanup(fork_log_summary.clear_cache)

        when = datetime.now() - timedelta(minutes=5)
        stamp = _stamp(when)
        with open(self.paths["frigate"], "w") as handle:
            for _ in range(3):
                handle.write(
                    f"{stamp}.107108146  [{stamp}] watchdog.front_door           "
                    "INFO    : No frames received from front_door in 20 seconds. "
                    "Exiting ffmpeg...\n"
                )
            handle.write(
                f"{stamp}.107108146  [{stamp}] frigate.app                    "
                "ERROR   : something else broke\n"
            )
        with open(self.paths["go2rtc"], "w") as handle:
            for port in (35836, 35840):
                handle.write(
                    f"{stamp}.301771246  {when.strftime('%H:%M:%S')}.301 WRN "
                    f'[rtsp] error="read tcp 127.0.0.1:8554->127.0.0.1:{port}: i/o '
                    f'timeout" url=ffmpeg:http://10.0.0.1/flv?user=admin&password={LEAK_MARKER}\n'
                )
        self.app = self.create_app()
        # The app's background samplers read stats; give them something quiet.
        self.app.stats_emitter = SimpleNamespace(get_latest_stats=lambda: {})

    def test_admin_gets_groups_attributed_from_the_config(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/log_summary")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["hours"], 24)
        # 10.0.0.1 is front_door's input host in the test config.
        self.assertEqual(body["cameras"], {"front_door": 5})
        self.assertEqual(body["unattributed"], 1)
        self.assertEqual(
            [(g["camera"], g["service"], g["count"]) for g in body["groups"]],
            [("front_door", "frigate", 3), ("front_door", "go2rtc", 2)],
        )
        self.assertNotIn(LEAK_MARKER, response.text)
        self.assertNotIn("password", response.text)
        self.assertTrue(body["sources"]["go2rtc"]["available"])

    def test_parameters_reach_the_summary(self):
        with AuthTestClient(self.app) as client:
            everything = client.get("/fork/log_summary?min_count=1&hours=1").json()
            nobody = client.get("/fork/log_summary?camera=nobody").json()
        self.assertEqual(everything["hours"], 1)
        self.assertEqual(len(everything["groups"]), 3)
        self.assertEqual(nobody["total"], 0)
        self.assertEqual(nobody["groups"], [])

    def test_response_is_cached_per_parameters(self):
        with AuthTestClient(self.app) as client:
            first = client.get("/fork/log_summary").json()
            os.remove(self.paths["frigate"])
            cached = client.get("/fork/log_summary").json()
            other = client.get("/fork/log_summary?min_count=1").json()
            with patch.object(fork_log_summary.time, "monotonic", return_value=1e12):
                expired = client.get("/fork/log_summary").json()
        self.assertEqual(cached, first)
        self.assertFalse(other["sources"]["frigate"]["available"])
        self.assertFalse(expired["sources"]["frigate"]["available"])
        self.assertEqual(expired["cameras"], {"front_door": 2})

    def test_cache_is_bounded(self):
        with (
            patch.object(fork_log_summary, "_CACHE_MAX", 2),
            AuthTestClient(self.app) as client,
        ):
            for hours in (1, 2, 3):
                self.assertEqual(
                    client.get(f"/fork/log_summary?hours={hours}").status_code, 200
                )
        self.assertEqual(len(fork_log_summary._cache), 1)

    def test_missing_logs_return_an_empty_summary(self):
        os.remove(self.paths["frigate"])
        os.remove(self.paths["go2rtc"])
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/log_summary")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["groups"], [])
        self.assertIsNone(response.json()["covered_from"])

    def test_invalid_parameters_are_rejected(self):
        with AuthTestClient(self.app) as client:
            for query in (
                "hours=0",
                "hours=169",
                "hours=abc",
                "min_count=0",
                "camera=bad%20name",
                "camera=a/../b",
                "camera=" + "a" * 65,
            ):
                with self.subTest(query=query):
                    response = client.get(f"/fork/log_summary?{query}")
                    self.assertEqual(response.status_code, 422)

    def test_non_admin_is_forbidden(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/fork/log_summary", headers=VIEWER)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("front_door", response.text)

    def test_anonymous_request_is_refused(self):
        with TestClient(self.app) as client:
            response = client.get("/fork/log_summary")
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("front_door", response.text)
