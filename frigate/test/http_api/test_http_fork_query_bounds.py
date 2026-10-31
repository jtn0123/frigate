"""Regression tests for unbounded API parameters and their fixes (fork B36)."""

from datetime import datetime
from unittest.mock import patch

from frigate.models import Event, Export, Previews, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class _BoundsTestCase(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Export, Previews, Recordings, ReviewSegment])
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()


class TestRecordingsUnavailableBounds(_BoundsTestCase):
    def test_scale_below_one_is_rejected(self):
        # scale=0 never advanced the scan and hung the worker
        with AuthTestClient(self.app) as client:
            for scale in (0, -5):
                with self.subTest(scale=scale):
                    response = client.get(
                        "/recordings/unavailable",
                        params={"after": 1000, "before": 1300, "scale": scale},
                    )
                    self.assertEqual(response.status_code, 422)

    def test_a_range_of_millions_of_segments_is_rejected(self):
        with AuthTestClient(self.app) as client:
            response = client.get(
                "/recordings/unavailable",
                params={"after": 1, "before": 1_700_000_000, "scale": 1},
            )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_an_ordinary_day_still_answers(self):
        with AuthTestClient(self.app) as client:
            response = client.get(
                "/recordings/unavailable",
                params={"after": 0.5, "before": 86400.5, "scale": 1},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [{"start_time": 0, "end_time": 86400}])


class TestVodEventPadding(_BoundsTestCase):
    def test_padding_outside_the_bounds_is_rejected_and_keeps_has_clip(self):
        now = datetime.now().timestamp()
        self.insert_mock_event("old", start_time=now - 600, has_clip=True)

        with AuthTestClient(self.app) as client:
            for padding in (-30, 3601):
                with self.subTest(padding=padding):
                    response = client.get(f"/vod/event/old?padding={padding}")
                    self.assertEqual(response.status_code, 422)

        # a negative padding inverted the window, and the 404 cleared has_clip
        self.assertTrue(Event.get(Event.id == "old").has_clip)


class TestBulkExportDeleteInProgress(_BoundsTestCase):
    def test_a_row_still_in_progress_is_refused_without_an_open_file(self):
        # mid-staging, ffmpeg holds a file in the cache rather than the
        # exports folder, so no export file is open yet
        Export.create(
            id="staging",
            camera="front_door",
            name="staging",
            date=100,
            video_path="/media/frigate/exports/staging.mp4",
            thumb_path="/media/frigate/exports/staging.webp",
            in_progress=True,
        )

        with patch("frigate.api.export._get_files_in_use", return_value=set()):
            with AuthTestClient(self.app) as client:
                response = client.post("/exports/delete", json={"ids": ["staging"]})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(Export.select().count(), 1)
