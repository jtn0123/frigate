"""HTTP tests for the fork update endpoint (fork UI42)."""

from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from frigate.fork.updates import MIN_REFRESH_SECONDS, ForkUpdateChecker
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

SHA = "d" * 40
RELEASE = {
    "tag_name": "fork/0.18.0-rc2-20260911.1",
    "name": "0.18.0-rc2-20260911.1",
    "body": f"### New\n\n- A change\n\n<!-- fork-build: {SHA} -->",
    "html_url": "https://github.com/jtn0123/frigate/releases/tag/fork/0.18.0-rc2-20260911.1",
    "published_at": "2026-09-11T12:00:00Z",
    "draft": False,
    "prerelease": False,
}
VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}


class TestHttpForkUpdates(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        self.fetches = 0
        self.now = 1_000_000.0
        self.checker = ForkUpdateChecker(
            f"0.18.0-{SHA[:9]}", fetch=self.fetch, clock=lambda: self.now
        )

    def fetch(self) -> list[dict[str, Any]]:
        self.fetches += 1
        return [RELEASE]

    def create_app(self, stats=None, event_metadata_publisher=None):
        app = super().create_app(stats, event_metadata_publisher)
        patcher = patch(
            "frigate.api.fork_updates.get_checker", return_value=self.checker
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        return app

    def test_reports_the_running_release(self):
        with AuthTestClient(self.create_app()) as client:
            response = client.get("/fork/updates")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "up-to-date"
        assert body["current_tag"] == "fork/0.18.0-rc2-20260911.1"
        assert body["releases"][0]["notes"] == "### New\n\n- A change"

    def test_only_admins_can_force_a_refresh(self):
        with AuthTestClient(self.create_app()) as client:
            client.get("/fork/updates")
            self.now += MIN_REFRESH_SECONDS

            viewer = client.get("/fork/updates?refresh=true", headers=VIEWER)
            assert viewer.status_code == 200
            assert self.fetches == 1

            client.get("/fork/updates?refresh=true")
            assert self.fetches == 2

    def test_version_check_off_never_contacts_github(self):
        self.minimal_config["telemetry"] = {"version_check": False}

        with AuthTestClient(self.create_app()) as client:
            response = client.get("/fork/updates")

        assert response.json()["status"] == "disabled"
        assert self.fetches == 0

    def test_requires_authentication(self):
        with TestClient(self.create_app()) as client:
            response = client.get("/fork/updates")

        assert response.status_code == 401
