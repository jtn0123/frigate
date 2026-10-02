"""HTTP tests for the snapshot, thumbnail, grid, clip and preview endpoints (fork D67)."""

import asyncio
import base64
import os
import shutil
import tempfile
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import cv2
import numpy as np
from fastapi import Response
from fastapi.responses import JSONResponse

from frigate.api import media as media_api
from frigate.api.defs.query.media_query_parameters import MediaMjpegFeedQueryParams
from frigate.models import Event, Previews, Recordings, Regions, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


def _jpg(width: int = 40, height: int = 20) -> bytes:
    _, encoded = cv2.imencode(".jpg", np.zeros((height, width, 3), np.uint8))
    return encoded.tobytes()


def _png(width: int = 40, height: int = 20) -> bytes:
    _, encoded = cv2.imencode(".png", np.zeros((height, width, 3), np.uint8))
    return encoded.tobytes()


def _decode(content: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)


class _MediaHttpTestCase(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Previews, Recordings, Regions, ReviewSegment])
        self.minimal_config["cameras"]["front_door"]["snapshots"] = {"enabled": True}
        self.app = super().create_app()
        self.tmp_dir = tempfile.mkdtemp()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        shutil.rmtree(self.tmp_dir, ignore_errors=True)
        super().tearDown()

    def track(self, event_id: str, tracked: MagicMock) -> None:
        """Make `event_id` an object currently tracked on front_door."""
        state = SimpleNamespace(
            name="front_door",
            tracked_objects={event_id: tracked},
            camera_config=self.app.frigate_config.cameras["front_door"],
        )
        self.app.detected_frames_processor = SimpleNamespace(
            get_camera_states=lambda: [state]
        )

    def live_frame(self, frame: np.ndarray | None, age: float = 0) -> MagicMock:
        processor = MagicMock()
        processor.get_current_frame.return_value = frame
        processor.get_current_frame_time.return_value = datetime.now().timestamp() - age
        self.app.detected_frames_processor = processor
        return processor


class TestMjpegFeed(_MediaHttpTestCase):
    def test_unknown_camera_is_404(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/back_yard")

        assert response.status_code == 404
        assert response.json()["message"] == "Camera not found"

    def test_known_camera_streams_multipart_frames(self):
        processor = self.live_frame(np.zeros((90, 160, 3), np.uint8))
        request = SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=self.app.frigate_config,
                detected_frames_processor=processor,
            )
        )
        params = MediaMjpegFeedQueryParams(fps=5, height=45, bbox=1)

        response = asyncio.run(media_api.mjpeg_feed(request, "front_door", params))

        assert response.media_type == "multipart/x-mixed-replace;boundary=frame"

    def test_imagestream_resizes_and_substitutes_blank_frames(self):
        processor = MagicMock()
        processor.get_current_frame.side_effect = [
            np.full((90, 160, 3), 255, np.uint8),
            None,
        ]

        with patch("frigate.api.media.time.sleep") as sleep:
            stream = media_api.imagestream(
                processor, "front_door", 4, 45, {"bounding_boxes": 1}
            )
            first = next(stream)
            second = next(stream)

        sleep.assert_called_with(0.25)
        processor.get_current_frame.assert_called_with(
            "front_door", {"bounding_boxes": 1}
        )
        prefix = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
        bodies = []
        for chunk in (first, second):
            assert chunk.startswith(prefix)
            assert chunk.endswith(b"\r\n\r\n")
            bodies.append(_decode(chunk[len(prefix) : -4]))

        assert all(body.shape == (45, 80, 3) for body in bodies)
        assert bodies[0].mean() > 200
        assert bodies[1].mean() < 5


class TestLatestFrame(_MediaHttpTestCase):
    def test_live_frame_is_resized_and_can_be_cached(self):
        self.live_frame(np.zeros((90, 160, 3), np.uint8))

        with AuthTestClient(self.app) as client:
            response = client.get("/front_door/latest.png?height=45&store=1")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert response.headers["cache-control"] == "private, max-age=60"
        assert "x-frigate-offline" not in response.headers
        assert _decode(response.content).shape == (45, 80, 3)

    def test_negative_height_is_rejected(self):
        self.live_frame(np.zeros((90, 160, 3), np.uint8))

        with AuthTestClient(self.app) as client:
            response = client.get("/front_door/latest.jpg?height=-4")

        assert response.status_code == 400
        assert "Invalid height / width requested" in response.json()

    def test_offline_camera_uses_cached_error_image(self):
        self.live_frame(None)
        self.app.camera_error_image = np.zeros((20, 40, 3), np.uint8)

        with patch(
            "frigate.api.media.get_most_recent_preview_frame", return_value=None
        ):
            with AuthTestClient(self.app) as client:
                response = client.get("/front_door/latest.webp")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/webp"
        assert response.headers["cache-control"] == "no-store"
        assert "x-frigate-offline" not in response.headers

    def test_birdseye_restream_converts_yuv_frame(self):
        self.minimal_config["birdseye"] = {"enabled": True, "restream": True}
        self.app = super().create_app()
        processor = self.live_frame(np.zeros((60, 80), np.uint8))

        with AuthTestClient(self.app) as client:
            response = client.get("/birdseye/latest.jpg?height=20")

        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        assert _decode(response.content).shape == (20, 40, 3)
        processor.get_current_frame.assert_called_once_with("birdseye")

    def test_birdseye_without_restream_is_404(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/birdseye/latest.jpg")

        assert response.status_code == 404


class TestSnapshotFromRecording(_MediaHttpTestCase):
    def test_extracts_frame_at_offset_in_segment(self):
        self.insert_mock_recording("/media/rec1.mp4", start_time=1000, end_time=1010)

        with patch(
            "frigate.api.media.get_image_from_recording", return_value=b"PNGDATA"
        ) as grab:
            with AuthTestClient(self.app) as client:
                png = client.get("/front_door/recordings/1004/snapshot.png?height=90")
                jpg = client.get("/front_door/recordings/1002/snapshot.jpg")

        assert png.status_code == 200
        assert png.headers["content-type"] == "image/png"
        assert png.content == b"PNGDATA"
        assert jpg.headers["content-type"] == "image/jpeg"
        first, second = grab.call_args_list
        assert first.args[1:] == ("/media/rec1.mp4", 4.0, "png", 90)
        assert second.args[1:] == ("/media/rec1.mp4", 2.0, "mjpeg", None)

    def test_frame_between_segments_retries_with_rounded_time(self):
        self.insert_mock_recording("/media/rec2.mp4", start_time=1001, end_time=1010)

        with patch(
            "frigate.api.media.get_image_from_recording", return_value=b"JPG"
        ) as grab:
            with AuthTestClient(self.app) as client:
                response = client.get("/front_door/recordings/1000.4/snapshot.jpg")

        assert response.status_code == 200
        assert grab.call_args.args[2] == 0

    def test_unparsable_frame_and_missing_recording_are_404(self):
        self.insert_mock_recording("/media/rec3.mp4", start_time=1000, end_time=1010)

        with patch("frigate.api.media.get_image_from_recording", return_value=b""):
            with AuthTestClient(self.app) as client:
                empty = client.get("/front_door/recordings/1005/snapshot.png")
                missing = client.get("/front_door/recordings/5000.5/snapshot.png")
                unknown = client.get("/back_yard/recordings/1005/snapshot.png")

        assert empty.status_code == 404
        assert empty.json()["message"] == "Unable to parse frame at time 1005.0"
        assert missing.status_code == 404
        assert missing.json()["message"] == "Recording not found at 5001"
        assert unknown.status_code == 404
        assert unknown.json()["message"] == "Camera not found"


class TestSubmitRecordingSnapshotToPlus(_MediaHttpTestCase):
    def test_uploads_decoded_frame(self):
        self.insert_mock_recording("/media/rec1.mp4", start_time=1000, end_time=1010)
        plus = self.app.frigate_config.plus_api

        with (
            patch(
                "frigate.api.media.get_image_from_recording", return_value=_png()
            ) as grab,
            patch.object(type(plus), "upload_image") as upload,
        ):
            with AuthTestClient(self.app) as client:
                response = client.post("/front_door/plus/1003")

        assert response.status_code == 200
        assert response.json()["message"] == "Successfully submitted image."
        assert grab.call_args.args[1:] == ("/media/rec1.mp4", 3.0, "png")
        image, camera = upload.call_args.args
        assert camera == "front_door"
        assert image.shape == (20, 40, 3)

    def test_failure_paths(self):
        self.insert_mock_recording("/media/rec1.mp4", start_time=1000, end_time=1010)

        with patch("frigate.api.media.get_image_from_recording", return_value=None):
            with AuthTestClient(self.app) as client:
                empty = client.post("/front_door/plus/1003")
                missing = client.post("/front_door/plus/9000")
                unknown = client.post("/back_yard/plus/1003")

        assert empty.status_code == 404
        assert empty.json()["message"] == "Unable to parse frame at time 1003.0"
        assert missing.status_code == 404
        assert missing.json()["message"] == "Recording not found at 9000.0"
        assert unknown.status_code == 404


class TestVodRoutes(_MediaHttpTestCase):
    def test_vod_hour_converts_the_requested_hour_to_a_range(self):
        with patch(
            "frigate.api.media.vod_ts", return_value=JSONResponse(content={"ok": 1})
        ) as vod:
            with AuthTestClient(self.app) as client:
                response = client.get("/vod/2024-05/3/10/front_door/UTC")

        assert response.status_code == 200
        start = datetime(2024, 5, 3, 10, tzinfo=UTC).timestamp()
        camera, start_ts, end_ts = vod.call_args.args
        assert camera == "front_door"
        assert start_ts == start
        assert (
            end_ts
            == (
                datetime(2024, 5, 3, 10, tzinfo=UTC)
                + timedelta(hours=1)
                - timedelta(milliseconds=1)
            ).timestamp()
        )

    def test_vod_hour_without_timezone_uses_local_zone(self):
        with (
            patch("frigate.api.media.get_localzone_name", return_value="Etc/UTC"),
            patch(
                "frigate.api.media.vod_ts", return_value=JSONResponse(content={})
            ) as vod,
        ):
            with AuthTestClient(self.app) as client:
                response = client.get("/vod/2024-05/3/10/front_door")

        assert response.status_code == 200
        assert vod.call_args.args[1] == datetime(2024, 5, 3, 10, tzinfo=UTC).timestamp()

    def test_vod_event_applies_padding(self):
        self.insert_mock_event("e1", start_time=1000, end_time=1030)

        with patch(
            "frigate.api.media.vod_ts", return_value=JSONResponse(content={})
        ) as vod:
            with AuthTestClient(self.app) as client:
                response = client.get("/vod/event/e1?padding=5")
                missing = client.get("/vod/event/missing")

        assert response.status_code == 200
        assert vod.call_args.args == ("front_door", 995, 1035)
        assert missing.status_code == 404
        assert missing.json()["message"] == "Event not found."

    def test_vod_event_in_progress_runs_to_now(self):
        self.insert_mock_event("e1", start_time=1000)
        Event.update(end_time=None).where(Event.id == "e1").execute()

        with patch(
            "frigate.api.media.vod_ts", return_value=JSONResponse(content={})
        ) as vod:
            with AuthTestClient(self.app) as client:
                client.get("/vod/event/e1")

        assert vod.call_args.args[2] >= datetime.now().timestamp() - 60


class TestEventSnapshot(_MediaHttpTestCase):
    def test_finished_event_snapshot_uses_query_overrides(self):
        self.insert_mock_event("e1")

        with patch(
            "frigate.api.media.get_event_snapshot_bytes",
            return_value=(b"JPEG", 12.5),
        ) as snap:
            with AuthTestClient(self.app) as client:
                response = client.get(
                    "/events/e1/snapshot.jpg"
                    "?download=true&timestamp=1&bbox=1&crop=1&height=100&quality=50"
                )

        assert response.status_code == 200
        assert response.content == b"JPEG"
        assert response.headers["x-frame-time"] == "12.5"
        assert response.headers["cache-control"] == "private, max-age=31536000"
        assert (
            response.headers["content-disposition"]
            == "attachment; filename=snapshot-e1.jpg"
        )
        kwargs = snap.call_args.kwargs
        assert kwargs["ext"] == "jpg"
        assert kwargs["timestamp"] is True
        assert kwargs["bounding_box"] is True
        assert kwargs["crop"] is True
        assert kwargs["height"] == 100
        assert kwargs["quality"] == 50

    def test_defaults_come_from_camera_snapshot_config(self):
        self.insert_mock_event("e1")
        snapshots = self.app.frigate_config.cameras["front_door"].snapshots

        with patch(
            "frigate.api.media.get_event_snapshot_bytes", return_value=(b"J", 1)
        ) as snap:
            with AuthTestClient(self.app) as client:
                response = client.get("/events/e1/snapshot.jpg")

        assert response.status_code == 200
        assert "content-disposition" not in response.headers
        kwargs = snap.call_args.kwargs
        assert kwargs["timestamp"] == snapshots.timestamp
        assert kwargs["bounding_box"] == snapshots.bounding_box
        assert kwargs["crop"] == snapshots.crop
        assert kwargs["quality"] == snapshots.quality

    def test_unavailable_snapshots(self):
        self.insert_mock_event("nosnap")
        Event.update(has_snapshot=False).where(Event.id == "nosnap").execute()
        self.insert_mock_event("empty")
        self.insert_mock_event("broken")

        def snapshot_bytes(event, **_kwargs):
            if event.id == "broken":
                raise RuntimeError("disk gone")
            return None, 0

        with patch(
            "frigate.api.media.get_event_snapshot_bytes", side_effect=snapshot_bytes
        ):
            with AuthTestClient(self.app) as client:
                nosnap = client.get("/events/nosnap/snapshot.jpg")
                empty = client.get("/events/empty/snapshot.jpg")
                broken = client.get("/events/broken/snapshot.jpg")

        assert nosnap.status_code == 404
        assert nosnap.json()["message"] == "Snapshot not available"
        assert empty.status_code == 404
        assert empty.json()["message"] == "Live frame not available"
        assert broken.status_code == 404
        assert broken.json()["message"] == "Unknown error occurred"

    def test_in_progress_event_uses_tracked_object(self):
        tracked = MagicMock()
        tracked.get_img_bytes.return_value = (b"LIVE", 3.0)
        self.track("live1", tracked)

        with AuthTestClient(self.app) as client:
            response = client.get("/events/live1/snapshot.jpg?height=50")

        assert response.status_code == 200
        assert response.content == b"LIVE"
        assert response.headers["cache-control"] == "no-store"
        assert tracked.get_img_bytes.call_args.kwargs["height"] == 50

    def test_untracked_event_without_processor_is_404(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/events/ghost/snapshot.jpg")

        assert response.status_code == 404
        assert response.json()["message"] == "Ongoing event not found"


class TestEventThumbnail(_MediaHttpTestCase):
    def _event_with_thumbnail(self, event_id: str, data: bytes) -> None:
        self.insert_mock_event(event_id)
        Event.update(thumbnail=base64.b64encode(data).decode()).where(
            Event.id == event_id
        ).execute()

    def test_stored_thumbnail_is_reencoded(self):
        self._event_with_thumbnail("e1", _jpg(40, 20))

        with AuthTestClient(self.app) as client:
            jpg = client.get("/events/e1/thumbnail.jpg?max_cache_age=99")
            webp = client.get("/events/e1/thumbnail.webp")
            png = client.get("/events/e1/thumbnail.png")
            android = client.get("/events/e1/thumbnail.jpg?format=android")

        assert jpg.status_code == 200
        assert jpg.headers["content-type"] == "image/jpeg"
        assert jpg.headers["cache-control"] == "private, max-age=99"
        assert webp.headers["content-type"] == "image/webp"
        assert webp.headers["cache-control"] == "private, max-age=2592000"
        assert png.headers["content-type"] == "image/png"
        assert _decode(jpg.content).shape == (20, 40, 3)
        # android pads the width to a 2:1 ratio
        assert _decode(android.content).shape == (20, 80, 3)

    def test_corrupt_thumbnail_is_404(self):
        self._event_with_thumbnail("e1", b"not an image")

        with AuthTestClient(self.app) as client:
            response = client.get("/events/e1/thumbnail.jpg")

        assert response.status_code == 404
        assert response.json()["message"] == "Event not found"

    def test_in_progress_event_uses_tracked_thumbnail(self):
        self.insert_mock_event("live1")
        Event.update(end_time=None).where(Event.id == "live1").execute()
        tracked = MagicMock()
        tracked.get_thumbnail.return_value = _jpg()
        self.track("live1", tracked)

        with AuthTestClient(self.app) as client:
            response = client.get("/events/live1/thumbnail.webp")

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        tracked.get_thumbnail.assert_called_once_with("webp")

    def test_unknown_event(self):
        with AuthTestClient(self.app) as client:
            no_processor = client.get("/events/ghost/thumbnail.jpg")

        self.app.detected_frames_processor = SimpleNamespace(
            get_camera_states=lambda: []
        )
        with AuthTestClient(self.app) as client:
            not_tracked = client.get("/events/ghost/thumbnail.jpg")

        assert no_processor.status_code == 404
        assert not_tracked.status_code == 404
        assert not_tracked.json()["message"] == "Event not found"


class TestRegionGrid(_MediaHttpTestCase):
    def _grid(self) -> list:
        grid = [[{"sizes": []} for _ in range(2)] for _ in range(2)]
        grid[1][0] = {"sizes": [0.1, 0.2], "std_dev": 0.05, "mean": 0.15}
        return grid

    def test_grid_snapshot_draws_cells_in_each_color(self):
        Regions.insert(camera="front_door", grid=self._grid(), last_update=1).execute()
        self.live_frame(np.zeros((1080, 1920, 3), np.uint8))

        colors = {}
        with AuthTestClient(self.app) as client:
            for color in ("red", "blue", "black", "white", "green", "purple"):
                response = client.get(f"/front_door/grid.jpg?color={color}")
                assert response.status_code == 200
                assert response.headers["cache-control"] == "no-store"
                colors[color] = _decode(response.content)

        # the populated cell (x=1, y=0) is outlined; empty cells are not
        assert colors["white"][0:540, 960:1920].max() > 200
        assert colors["white"][600:1000, 100:900].max() < 30
        assert colors["red"][0:540, 960:1920, 2].max() > 200
        assert colors["blue"][0:540, 960:1920, 0].max() > 200
        assert colors["black"].max() < 30
        assert colors["purple"][0:540, 960:1920, 1].max() > 200

    def test_grid_snapshot_failures(self):
        self.live_frame(np.zeros((1080, 1920, 3), np.uint8))
        with AuthTestClient(self.app) as client:
            no_grid = client.get("/front_door/grid.jpg")
            unknown = client.get("/back_yard/grid.jpg")

        self.live_frame(np.zeros((1080, 1920, 3), np.uint8), age=60)
        with AuthTestClient(self.app) as client:
            stale = client.get("/front_door/grid.jpg")

        assert no_grid.status_code == 500
        assert no_grid.json()["message"] == "Unable to get region grid"
        assert unknown.status_code == 404
        assert stale.status_code == 500
        assert stale.json()["message"] == "Unable to get valid frame"

    def test_clear_region_grid_stores_an_empty_grid(self):
        Regions.insert(camera="front_door", grid=self._grid(), last_update=1).execute()

        with AuthTestClient(self.app) as client:
            cleared = client.delete("/front_door/region_grid")
            unknown = client.delete("/back_yard/region_grid")

        assert cleared.status_code == 200
        assert cleared.json()["message"] == "Region grid cleared"
        row = Regions.get(Regions.camera == "front_door")
        assert all(cell["sizes"] == [] for column in row.grid for cell in column)
        assert row.last_update > 1
        assert unknown.status_code == 404


class TestEventSnapshotClean(_MediaHttpTestCase):
    def test_snapshots_disabled_or_missing_event(self):
        self.insert_mock_event("e1")
        Event.update(has_snapshot=False).where(Event.id == "e1").execute()

        with AuthTestClient(self.app) as client:
            disabled = client.get("/events/e1/snapshot-clean.webp")
            missing = client.get("/events/missing/snapshot-clean.webp")

        assert disabled.status_code == 404
        assert disabled.json()["message"] == "Snapshots must be enabled in the config"
        assert missing.status_code == 404
        assert missing.json()["message"] == "Event not found"

    def test_stored_webp_is_served(self):
        self.insert_mock_event("e1")
        path = os.path.join(self.tmp_dir, "front_door-e1-clean.webp")
        with open(path, "wb") as f:
            f.write(b"RIFFWEBP")

        with patch(
            "frigate.api.media.get_event_snapshot_path", return_value=(path, True)
        ) as lookup:
            with AuthTestClient(self.app) as client:
                response = client.get("/events/e1/snapshot-clean.webp?download=true")

        assert response.status_code == 200
        assert response.content == b"RIFFWEBP"
        assert response.headers["cache-control"] == "private, max-age=31536000"
        assert (
            response.headers["content-disposition"]
            == "attachment; filename=snapshot-e1-clean.webp"
        )
        assert lookup.call_args.kwargs == {"clean_only": True}

    def test_png_is_converted_to_webp(self):
        self.insert_mock_event("e1")

        with (
            patch(
                "frigate.api.media.get_event_snapshot_path",
                return_value=("/clips/front_door-e1-clean.png", True),
            ),
            patch(
                "frigate.api.media.load_event_snapshot_image",
                return_value=(np.zeros((20, 40, 3), np.uint8), True),
            ),
        ):
            with AuthTestClient(self.app) as client:
                response = client.get("/events/e1/snapshot-clean.webp")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/webp"
        assert _decode(response.content).shape == (20, 40, 3)

    def test_clean_snapshot_failures(self):
        self.insert_mock_event("e1")
        png = ("/clips/front_door-e1-clean.png", True)

        with AuthTestClient(self.app) as client:
            with patch(
                "frigate.api.media.get_event_snapshot_path",
                return_value=(None, False),
            ):
                unavailable = client.get("/events/e1/snapshot-clean.webp")
            with (
                patch("frigate.api.media.get_event_snapshot_path", return_value=png),
                patch(
                    "frigate.api.media.load_event_snapshot_image",
                    return_value=(None, False),
                ),
            ):
                unreadable = client.get("/events/e1/snapshot-clean.webp")
            with (
                patch("frigate.api.media.get_event_snapshot_path", return_value=png),
                patch(
                    "frigate.api.media.load_event_snapshot_image",
                    return_value=(np.zeros((20, 40, 3), np.uint8), True),
                ),
                patch("frigate.api.media.cv2.imencode", return_value=(False, None)),
            ):
                unencodable = client.get("/events/e1/snapshot-clean.webp")
            with patch(
                "frigate.api.media.get_event_snapshot_path",
                side_effect=OSError("io"),
            ):
                errored = client.get("/events/e1/snapshot-clean.webp")

        assert unavailable.status_code == 404
        assert unavailable.json()["message"] == "Clean snapshot not available"
        assert unreadable.status_code == 400
        assert unreadable.json()["message"] == "Unable to load clean snapshot for event"
        assert unencodable.status_code == 400
        assert unencodable.json()["message"] == "Unable to convert snapshot to webp"
        assert errored.status_code == 400

    def test_in_progress_event_uses_tracked_clean_webp(self):
        self.insert_mock_event("live1")
        Event.update(end_time=None).where(Event.id == "live1").execute()
        tracked = MagicMock()
        tracked.get_clean_webp.return_value = b"LIVEWEBP"
        self.track("live1", tracked)

        with AuthTestClient(self.app) as client:
            response = client.get("/events/live1/snapshot-clean.webp")

        assert response.status_code == 200
        assert response.content == b"LIVEWEBP"
        assert response.headers["cache-control"] == "no-cache"

    def test_in_progress_event_without_processor_is_404(self):
        self.insert_mock_event("live1")
        Event.update(end_time=None).where(Event.id == "live1").execute()

        with AuthTestClient(self.app) as client:
            response = client.get("/events/live1/snapshot-clean.webp")

        assert response.status_code == 404
        assert response.json()["message"] == "Event not found"


class TestClips(_MediaHttpTestCase):
    def test_event_clip_pads_the_range(self):
        self.insert_mock_event("e1", start_time=1000, end_time=1030)

        with patch(
            "frigate.api.media.recording_clip", return_value=Response(b"MP4")
        ) as clip:
            with AuthTestClient(self.app) as client:
                response = client.get("/events/e1/clip.mp4?padding=4")

        assert response.status_code == 200
        assert response.content == b"MP4"
        assert clip.call_args.args[1:] == ("front_door", 996, 1034)

    def test_event_clip_unavailable(self):
        self.insert_mock_event("noclip", has_clip=False)

        with AuthTestClient(self.app) as client:
            noclip = client.get("/events/noclip/clip.mp4")
            missing = client.get("/events/missing/clip.mp4")

        assert noclip.status_code == 404
        assert noclip.json()["message"] == "Clip not available"
        assert missing.status_code == 404
        assert missing.json()["message"] == "Event not found"

    def test_in_progress_event_clip_runs_to_now(self):
        self.insert_mock_event("e1", start_time=1000)
        Event.update(end_time=None).where(Event.id == "e1").execute()

        with patch(
            "frigate.api.media.recording_clip", return_value=Response(b"MP4")
        ) as clip:
            with AuthTestClient(self.app) as client:
                client.get("/events/e1/clip.mp4")

        assert clip.call_args.args[3] >= datetime.now().timestamp() - 60

    def test_review_clip(self):
        self.insert_mock_review_segment("r1", start_time=2000, end_time=2050)

        with patch(
            "frigate.api.media.recording_clip", return_value=Response(b"MP4")
        ) as clip:
            with AuthTestClient(self.app) as client:
                response = client.get("/review/r1/clip.mp4?padding=10")
                missing = client.get("/review/missing/clip.mp4")

        assert response.status_code == 200
        assert clip.call_args.args[1:] == ("front_door", 1990, 2060)
        assert missing.status_code == 404
        assert missing.json()["message"] == "Review not found"

    def test_label_clip_uses_latest_event_with_a_clip(self):
        self.insert_mock_event("a1", start_time=1000, end_time=1010)

        with patch(
            "frigate.api.media.recording_clip", return_value=Response(b"MP4")
        ) as clip:
            with AuthTestClient(self.app) as client:
                any_label = client.get("/front_door/any/clip.mp4")
                by_label = client.get("/front_door/Mock/clip.mp4")
                other = client.get("/front_door/car/clip.mp4")

        assert any_label.status_code == 200
        assert by_label.status_code == 200
        assert clip.call_args.args[1:] == ("front_door", 1000, 1010)
        # MAX() over no rows yields a NULL id, so the event lookup misses
        assert other.status_code == 404


class TestPreviews(_MediaHttpTestCase):
    def setUp(self):
        super().setUp()
        cache_patch = patch("frigate.api.media.CACHE_DIR", self.tmp_dir)
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        # a day ago, so the handlers read the hourly preview mp4
        self.start_ts = float(int(datetime.now().timestamp()) - 86400)
        self.end_ts = self.start_ts + 10

    def _preview(self) -> None:
        Previews.insert(
            id="p1",
            camera="front_door",
            path="/media/previews/p1.mp4",
            start_time=self.start_ts - 125,
            end_time=self.start_ts + 3475,
            duration=3600,
        ).execute()

    def _url(self, extension: str) -> str:
        return (
            f"/front_door/start/{self.start_ts}/end/{self.end_ts}/preview.{extension}"
        )

    def test_gif_from_hourly_preview(self):
        self._preview()
        ffmpeg = Mock(return_value=Mock(returncode=0, stdout=b"GIF89a"))

        with patch("frigate.api.media.sp.run", ffmpeg):
            with AuthTestClient(self.app) as client:
                response = client.get(self._url("gif") + "?max_cache_age=30")

        assert response.status_code == 200
        assert response.content == b"GIF89a"
        assert response.headers["cache-control"] == "private, max-age=30"
        cmd = ffmpeg.call_args.args[0]
        assert cmd[cmd.index("-ss") + 1] == "00:2:5"
        assert cmd[cmd.index("-t") + 1] == "10.0"
        assert cmd[cmd.index("-i") + 1] == "/media/previews/p1.mp4"

    def test_mp4_from_hourly_preview(self):
        self._preview()

        def run(cmd, **_kwargs):
            with open(cmd[-1], "wb") as f:
                f.write(b"MP4DATA")
            return Mock(returncode=0)

        with patch("frigate.api.media.sp.run", side_effect=run) as ffmpeg:
            with AuthTestClient(self.app) as client:
                response = client.get(self._url("mp4"))

        assert response.status_code == 200
        assert response.content == b"MP4DATA"
        assert response.headers["content-length"] == "7"
        assert response.headers["x-accel-redirect"].startswith(
            "/cache/preview_front_door_"
        )
        assert ffmpeg.call_args.args[0][-1].startswith(self.tmp_dir)

    def test_hourly_preview_missing_or_failing(self):
        with AuthTestClient(self.app) as client:
            gif_missing = client.get(self._url("gif"))
            mp4_missing = client.get(self._url("mp4"))

        self._preview()
        failing = Mock(return_value=Mock(returncode=1, stdout=b"", stderr=b"boom"))
        with patch("frigate.api.media.sp.run", failing):
            with AuthTestClient(self.app) as client:
                gif_failed = client.get(self._url("gif"))
                mp4_failed = client.get(self._url("mp4"))

        for response in (gif_missing, mp4_missing):
            assert response.status_code == 404
            assert response.json()["message"] == "Preview not found"
        for response in (gif_failed, mp4_failed):
            assert response.status_code == 500
            assert response.json()["message"] == "Unable to create preview gif"

    def test_current_hour_frames(self):
        start_ts = float(int(datetime.now().timestamp()))
        preview_dir = os.path.join(self.tmp_dir, "preview_frames")
        os.makedirs(preview_dir)
        frame = os.path.join(preview_dir, f"preview_front_door-{start_ts + 1}.webp")
        with open(frame, "wb") as f:
            f.write(b"frame")
        base = f"/front_door/start/{start_ts}/end/{start_ts + 10}/preview"

        def run(cmd, **kwargs):
            assert kwargs["input"].decode().startswith(f"file '{frame}'")
            if cmd[-1] != "-":
                with open(cmd[-1], "wb") as f:
                    f.write(b"MP4")
            return Mock(returncode=0, stdout=b"GIF89a")

        with patch("frigate.api.media.sp.run", side_effect=run):
            with AuthTestClient(self.app) as client:
                mp4 = client.get(base + ".mp4")

        failing = Mock(return_value=Mock(returncode=1, stdout=b"", stderr=b"x"))
        with patch("frigate.api.media.sp.run", failing):
            with AuthTestClient(self.app) as client:
                gif_failed = client.get(base + ".gif")
                mp4_failed = client.get(base + ".mp4")

        assert mp4.status_code == 200
        assert mp4.content == b"MP4"
        assert gif_failed.status_code == 500
        assert mp4_failed.status_code == 500

    def test_event_preview_caps_the_range_at_twenty_seconds(self):
        self.insert_mock_event("long", start_time=1000, end_time=1100)
        self.insert_mock_event("short", start_time=2000, end_time=2005)
        self.insert_mock_event("live", start_time=3000)
        Event.update(end_time=None).where(Event.id == "live").execute()
        gif = AsyncMock(return_value=Response(b"GIF"))

        with patch("frigate.api.media.preview_gif", gif):
            with AuthTestClient(self.app) as client:
                for event_id in ("long", "short", "live"):
                    assert client.get(f"/events/{event_id}/preview.gif").content == (
                        b"GIF"
                    )
                missing = client.get("/events/missing/preview.gif")

        ranges = [c.args[1:] for c in gif.call_args_list]
        assert ranges == [
            ("front_door", 1000, 1020),
            ("front_door", 2000, 2005),
            ("front_door", 3000, 3020),
        ]
        assert missing.status_code == 404

    def test_review_preview_pads_the_range(self):
        self.insert_mock_review_segment("r1", start_time=1000, end_time=1010)
        gif = AsyncMock(return_value=Response(b"GIF"))
        mp4 = AsyncMock(return_value=Response(b"MP4"))

        with (
            patch("frigate.api.media.preview_gif", gif),
            patch("frigate.api.media.preview_mp4", mp4),
        ):
            with AuthTestClient(self.app) as client:
                as_gif = client.get("/review/r1/preview")
                as_mp4 = client.get("/review/r1/preview?format=mp4")
                missing = client.get("/review/missing/preview")

        assert as_gif.content == b"GIF"
        assert as_mp4.content == b"MP4"
        assert gif.call_args.args[1:] == ("front_door", 992, 1018)
        assert mp4.call_args.args[1:] == ("front_door", 992, 1018)
        assert missing.status_code == 404
        assert missing.json()["message"] == "Review segment not found"

    def test_preview_thumbnail_rejects_foreign_names(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/preview/front_door-1.webp/thumbnail.jpg")
            too_long = client.get(f"/preview/preview_{'a' * 1000}/thumbnail.webp")

        assert response.status_code == 400
        assert response.json()["message"] == "Invalid preview filename"
        assert too_long.status_code == 403


class TestLabelMedia(_MediaHttpTestCase):
    def test_label_thumbnail_uses_latest_event(self):
        self.insert_mock_event("a1")
        Event.update(thumbnail=base64.b64encode(_jpg()).decode()).execute()

        with AuthTestClient(self.app) as client:
            any_label = client.get("/front_door/any/thumbnail.jpg")
            best = client.get("/front_door/Mock/best.jpg")

        for response in (any_label, best):
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, max-age=60"
            assert _decode(response.content).shape == (20, 40, 3)

    def test_label_snapshot(self):
        self.insert_mock_event("a1", start_time=1000)
        self.insert_mock_event("a2", start_time=2000)

        with patch(
            "frigate.api.media.get_event_snapshot_bytes", return_value=(b"SNAP", 1.0)
        ) as snap:
            with AuthTestClient(self.app) as client:
                any_label = client.get("/front_door/any/snapshot.jpg")
                by_label = client.get("/front_door/Mock/snapshot.jpg")
                blank = client.get("/front_door/car/snapshot.jpg")

        assert any_label.content == b"SNAP"
        assert by_label.content == b"SNAP"
        assert [c.args[0].id for c in snap.call_args_list] == ["a2", "a2"]
        assert blank.status_code == 200
        assert _decode(blank.content).shape == (720, 1280, 3)
