"""HTTP tests for expiring clip share links (fork UI11)."""

import asyncio
import time
from unittest.mock import patch

from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from frigate.api import fork_share
from frigate.models import Event, Recordings, ShareLink
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class TestHttpForkShare(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ShareLink])
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _link(self, token: str, event_id: str, **fields) -> ShareLink:
        values = {
            "camera": "front_door",
            "created_by": "admin",
            "created_at": time.time(),
            "expires_at": time.time() + 3600,
        }
        values.update(fields)
        return ShareLink.create(token=token, event_id=event_id, **values)

    def _free_slots(self) -> int:
        """Count the free clip slots by taking them all, then give them back."""
        taken = 0
        while fork_share._clip_slots.acquire(blocking=False):
            taken += 1
        for _ in range(taken):
            fork_share._clip_slots.release()
        return taken

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

    def test_clip_of_open_event_is_capped(self):
        start = time.time() - 3 * 3600
        self.insert_mock_event("event-share-open", start_time=start)
        Event.update(end_time=None).where(Event.id == "event-share-open").execute()
        self._link("openToken12345678901234567890123", "event-share-open")
        stub = JSONResponse(content={"success": True})

        with patch.object(fork_share, "recording_clip", return_value=stub) as clip:
            with TestClient(self.app) as client:
                response = client.get(
                    "/fork/share/openToken12345678901234567890123/clip.mp4"
                )

        assert response.status_code == 200
        _request, camera, start_ts, end_ts = clip.call_args.args
        assert camera == "front_door"
        assert start_ts == start
        assert end_ts == start + fork_share.MAX_SHARE_CLIP_SECONDS

    def test_clip_of_short_event_keeps_its_end(self):
        start = time.time() - 3600
        self.insert_mock_event("event-share-short", start_time=start)
        self._link("shortToken1234567890123456789012", "event-share-short")
        stub = JSONResponse(content={"success": True})

        with patch.object(fork_share, "recording_clip", return_value=stub) as clip:
            with TestClient(self.app) as client:
                client.get("/fork/share/shortToken1234567890123456789012/clip.mp4")

        assert clip.call_args.args[2:] == (start, start + 20)

    def test_clip_of_long_closed_event_is_capped(self):
        start = time.time() - 7200
        self.insert_mock_event(
            "event-share-long", start_time=start, end_time=start + 3600
        )
        self._link("longToken12345678901234567890123", "event-share-long")
        stub = JSONResponse(content={"success": True})

        with patch.object(fork_share, "recording_clip", return_value=stub) as clip:
            with TestClient(self.app) as client:
                client.get("/fork/share/longToken12345678901234567890123/clip.mp4")

        assert clip.call_args.args[3] == start + fork_share.MAX_SHARE_CLIP_SECONDS

    def test_camera_mismatch_is_not_found(self):
        self.insert_mock_event("event-share-moved", camera="back_yard")
        self._link("movedToken1234567890123456789012", "event-share-moved")

        with patch.object(fork_share, "recording_clip") as clip:
            with TestClient(self.app) as client:
                meta = client.get("/fork/share/movedToken1234567890123456789012")
                video = client.get(
                    "/fork/share/movedToken1234567890123456789012/clip.mp4"
                )

        assert meta.status_code == 404
        assert video.status_code == 404
        assert video.json()["message"] == "Share link not found"
        clip.assert_not_called()

    def test_clip_is_refused_when_every_slot_is_taken(self):
        self.insert_mock_event("event-share-busy")
        self._link("busyToken12345678901234567890123", "event-share-busy")
        slots = fork_share.MAX_CONCURRENT_SHARE_CLIPS
        for _ in range(slots):
            assert fork_share._clip_slots.acquire(blocking=False)
        self.addCleanup(
            lambda: [fork_share._clip_slots.release() for _ in range(slots)]
        )

        with patch.object(fork_share, "recording_clip") as clip:
            with TestClient(self.app) as client:
                response = client.get(
                    "/fork/share/busyToken12345678901234567890123/clip.mp4"
                )

        assert response.status_code == 429
        assert response.json() == {
            "success": False,
            "message": "Too many clip requests",
        }
        clip.assert_not_called()

    def test_slot_is_returned_when_no_stream_starts(self):
        self.insert_mock_event("event-share-slot")
        self._link("slotToken12345678901234567890123", "event-share-slot")

        with TestClient(self.app) as client:
            response = client.get(
                "/fork/share/slotToken12345678901234567890123/clip.mp4"
            )

        assert response.status_code == 400
        assert self._free_slots() == fork_share.MAX_CONCURRENT_SHARE_CLIPS

    def test_slot_is_returned_when_the_stream_ends(self):
        self.insert_mock_event("event-share-stream")
        self._link("streamToken123456789012345678901", "event-share-stream")
        free_while_streaming: list[int] = []

        def chunks():
            free_while_streaming.append(self._free_slots())
            yield b"clip"

        stub = StreamingResponse(chunks(), media_type="video/mp4")
        with patch.object(fork_share, "recording_clip", return_value=stub):
            with TestClient(self.app) as client:
                response = client.get(
                    "/fork/share/streamToken123456789012345678901/clip.mp4"
                )

        assert response.content == b"clip"
        assert free_while_streaming == [fork_share.MAX_CONCURRENT_SHARE_CLIPS - 1]
        assert self._free_slots() == fork_share.MAX_CONCURRENT_SHARE_CLIPS

    def test_slot_is_returned_when_the_stream_is_never_read(self):
        async def body():
            yield b"clip"

        assert fork_share._clip_slots.acquire(blocking=False)
        stream = fork_share._SlotStream(body())
        assert self._free_slots() == fork_share.MAX_CONCURRENT_SHARE_CLIPS - 1

        del stream

        assert self._free_slots() == fork_share.MAX_CONCURRENT_SHARE_CLIPS

    def test_slot_is_returned_once_when_the_stream_is_cancelled(self):
        async def body():
            raise asyncio.CancelledError
            yield b""  # pragma: no cover

        async def read(stream):
            async for _chunk in stream:
                pass

        assert fork_share._clip_slots.acquire(blocking=False)
        stream = fork_share._SlotStream(body())

        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(read(stream))

        # a second release would raise ValueError on the bounded semaphore
        stream.release()
        assert self._free_slots() == fork_share.MAX_CONCURRENT_SHARE_CLIPS
