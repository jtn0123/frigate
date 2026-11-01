"""Regression tests for unbounded API parameters and their fixes (fork B36)."""

from datetime import UTC, datetime
from unittest.mock import patch

from fastapi.responses import JSONResponse

from frigate.models import Event, Export, Previews, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp
from frigate.util.time import get_timezone


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


class TestHourEndpointsUseTheDatesOffset(_BoundsTestCase):
    # 10:00 in New York is 15:00 UTC in winter (EST) and 14:00 UTC in summer
    # (EDT); one of them was an hour off whatever the day the test ran
    CASES = (
        ("2024-01", 15, datetime(2024, 1, 15, 15, tzinfo=UTC)),
        ("2024-07", 15, datetime(2024, 7, 15, 14, tzinfo=UTC)),
    )

    def test_vod_hour(self):
        for year_month, day, expected in self.CASES:
            with self.subTest(year_month=year_month):
                with patch(
                    "frigate.api.media.vod_ts", return_value=JSONResponse(content={})
                ) as vod:
                    with AuthTestClient(self.app) as client:
                        response = client.get(
                            f"/vod/{year_month}/{day}/10/front_door/America,New_York"
                        )

                self.assertEqual(response.status_code, 200)
                start_ts, end_ts = vod.call_args.args[1:3]
                self.assertEqual(start_ts, expected.timestamp())
                self.assertAlmostEqual(end_ts - start_ts, 3600, places=2)

    def test_preview_hour(self):
        for year_month, day, expected in self.CASES:
            with self.subTest(year_month=year_month):
                with patch(
                    "frigate.api.preview.preview_ts",
                    return_value=JSONResponse(content=[]),
                ) as preview:
                    with AuthTestClient(self.app) as client:
                        response = client.get(
                            f"/preview/{year_month}/{day}/10/front_door/America,New_York"
                        )

                self.assertEqual(response.status_code, 200)
                self.assertEqual(preview.call_args.args[1], expected.timestamp())

    def test_an_hour_across_the_fall_back_change_is_one_real_hour(self):
        # 2024-11-03 01:00 New York is the first (EDT) 1 o'clock: 05:00 UTC
        with patch(
            "frigate.api.media.vod_ts", return_value=JSONResponse(content={})
        ) as vod:
            with AuthTestClient(self.app) as client:
                client.get("/vod/2024-11/3/1/front_door/America,New_York")

        start_ts, end_ts = vod.call_args.args[1:3]
        self.assertEqual(start_ts, datetime(2024, 11, 3, 5, tzinfo=UTC).timestamp())
        self.assertAlmostEqual(end_ts - start_ts, 3600, places=2)


class TestEventsTimeOfDayFilter(_BoundsTestCase):
    def _ids(self, **params) -> set[str]:
        with AuthTestClient(self.app) as client:
            response = client.get(
                "/events",
                params={"timezone": "America/New_York", "limit": 100, **params},
            )
        self.assertEqual(response.status_code, 200)
        return {event["id"] for event in response.json()}

    def _event(self, id: str, local: datetime) -> None:
        self.insert_mock_event(id, start_time=local.timestamp())

    def test_each_event_uses_its_own_offset_and_the_start_minute(self):
        tz = get_timezone("America/New_York")
        self._event("winter_start", datetime(2024, 1, 15, 8, 0, 30, tzinfo=tz))
        self._event("winter_before", datetime(2024, 1, 15, 7, 59, tzinfo=tz))
        self._event("summer_inside", datetime(2024, 7, 15, 8, 30, tzinfo=tz))
        self._event("summer_end", datetime(2024, 7, 15, 9, 0, tzinfo=tz))

        self.assertEqual(
            self._ids(time_range="08:00,09:00"), {"winter_start", "summer_inside"}
        )
        # the same with explicit bounds around both dates
        self.assertEqual(
            self._ids(
                time_range="08:00,09:00",
                after=datetime(2024, 1, 1, tzinfo=UTC).timestamp(),
                before=datetime(2024, 8, 1, tzinfo=UTC).timestamp(),
            ),
            {"winter_start", "summer_inside"},
        )

    def test_an_overnight_range_spans_midnight(self):
        tz = get_timezone("America/New_York")
        self._event("late", datetime(2024, 1, 15, 22, 0, tzinfo=tz))
        self._event("early", datetime(2024, 7, 16, 5, 59, tzinfo=tz))
        self._event("midday", datetime(2024, 7, 16, 12, 0, tzinfo=tz))

        self.assertEqual(self._ids(time_range="20:00,06:00"), {"late", "early"})


class TestMotionActivityScale(_BoundsTestCase):
    def test_scale_is_bounded(self):
        # 0 divided by zero; over 3600 made a chunk of 0 rows and range() raised
        with AuthTestClient(self.app) as client:
            for scale in (0, 3601):
                with self.subTest(scale=scale):
                    response = client.get(
                        "/review/activity/motion", params={"scale": scale}
                    )
                    self.assertEqual(response.status_code, 422)

            for scale in (1, 3600):
                with self.subTest(scale=scale):
                    response = client.get(
                        "/review/activity/motion", params={"scale": scale}
                    )
                    self.assertEqual(response.status_code, 200)


class TestMjpegFeedBounds(_BoundsTestCase):
    def test_fps_and_height_are_bounded(self):
        # fps=0 divided by zero in the stream loop, height=0 in the resize
        with AuthTestClient(self.app) as client:
            for params in ({"fps": 0}, {"fps": 31}, {"height": 0}, {"height": 15}):
                with self.subTest(params=params):
                    response = client.get("/front_door", params=params)
                    self.assertEqual(response.status_code, 422)
