"""HTTP tests for expiring clip share links (fork UI11)."""

import time

from fastapi.testclient import TestClient

from frigate.models import Event, Recordings, ShareLink
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class TestHttpForkShare(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ShareLink])
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def test_create_share_returns_token_and_expiry(self):
        self.insert_mock_event("event-share-1")
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/fork/share",
                json={"event_id": "event-share-1", "expires_in_hours": 2},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["event_id"] == "event-share-1"
        assert body["camera"] == "front_door"
        assert body["url"] == f"/share/{body['token']}"
        assert body["expires_at"] > time.time()
        link = ShareLink.get(ShareLink.token == body["token"])
        assert link.event_id == "event-share-1"
        assert link.created_by == "admin"

    def test_create_share_rejects_missing_event(self):
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/fork/share",
                json={"event_id": "missing"},
            )

        assert response.status_code == 404

    def test_create_share_rejects_event_without_clip(self):
        self.insert_mock_event("event-no-clip", has_clip=False)
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/fork/share",
                json={"event_id": "event-no-clip"},
            )

        assert response.status_code == 400

    def test_create_share_requires_authentication(self):
        self.insert_mock_event("event-share-auth")
        with TestClient(self.app) as client:
            response = client.post(
                "/fork/share",
                json={"event_id": "event-share-auth"},
            )

        assert response.status_code == 401

    def test_get_share_is_public(self):
        self.insert_mock_event("event-share-pub")
        ShareLink.create(
            token="publicToken1234567890123456789012",
            event_id="event-share-pub",
            camera="front_door",
            created_by="admin",
            created_at=time.time(),
            expires_at=time.time() + 3600,
        )
        with TestClient(self.app) as client:
            response = client.get("/fork/share/publicToken1234567890123456789012")

        assert response.status_code == 200
        body = response.json()
        assert body["event_id"] == "event-share-pub"
        assert body["camera"] == "front_door"
        assert body["label"] == "Mock"

    def test_get_share_expired_is_gone(self):
        self.insert_mock_event("event-share-old")
        ShareLink.create(
            token="expiredToken123456789012345678901",
            event_id="event-share-old",
            camera="front_door",
            created_by="admin",
            created_at=time.time() - 7200,
            expires_at=time.time() - 60,
        )
        with TestClient(self.app) as client:
            response = client.get("/fork/share/expiredToken123456789012345678901")

        assert response.status_code == 410

    def test_get_share_unknown_token_is_not_found(self):
        with TestClient(self.app) as client:
            response = client.get("/fork/share/unknownToken123456789012345678")

        assert response.status_code == 404

    def test_get_share_clip_without_recordings(self):
        self.insert_mock_event("event-share-clip")
        ShareLink.create(
            token="clipToken123456789012345678901234",
            event_id="event-share-clip",
            camera="front_door",
            created_by="admin",
            created_at=time.time(),
            expires_at=time.time() + 3600,
        )
        with TestClient(self.app) as client:
            response = client.get(
                "/fork/share/clipToken123456789012345678901234/clip.mp4"
            )

        assert response.status_code == 400
        assert "No recordings" in response.json()["message"]

    def test_create_share_caps_expiry(self):
        self.insert_mock_event("event-share-cap")
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/fork/share",
                json={"event_id": "event-share-cap", "expires_in_hours": 999},
            )

        assert response.status_code == 422

    def test_get_share_rejects_malformed_token(self):
        with TestClient(self.app) as client:
            response = client.get("/fork/share/../etc/passwd")

        assert response.status_code == 404
