import os
import shutil
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import Request
from peewee import DoesNotExist

from frigate.api.auth import get_allowed_cameras_for_filter, get_current_user
from frigate.models import Event, Recordings, ReviewSegment, UserReviewStatus
from frigate.review.types import SeverityEnum
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class TestHttpReview(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, UserReviewStatus])
        self.app = super().create_app()
        self.user_id = "admin"

        # Mock get_current_user for all tests
        # This mock uses headers set by AuthTestClient
        async def mock_get_current_user(request: Request):
            username = request.headers.get("remote-user")
            role = request.headers.get("remote-role")
            if not username or not role:
                from fastapi.responses import JSONResponse

                return JSONResponse(
                    content={"message": "No authorization headers."}, status_code=401
                )
            return {"username": username, "role": role}

        self.app.dependency_overrides[get_current_user] = mock_get_current_user

        async def mock_get_allowed_cameras_for_filter(request: Request):
            return ["front_door"]

        self.app.dependency_overrides[get_allowed_cameras_for_filter] = (
            mock_get_allowed_cameras_for_filter
        )

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _get_reviews(self, ids: list[str]):
        return list(
            ReviewSegment.select(ReviewSegment.id)
            .where(ReviewSegment.id.in_(ids))
            .execute()
        )

    def _get_recordings(self, ids: list[str]):
        return list(
            Recordings.select(Recordings.id).where(Recordings.id.in_(ids)).execute()
        )

    def _insert_user_review_status(self, review_id: str, reviewed: bool = True):
        UserReviewStatus.create(
            user_id=self.user_id,
            review_segment=ReviewSegment.get(ReviewSegment.id == review_id),
            has_been_reviewed=reviewed,
        )

    ####################################################################################################################
    ###################################  GET /review Endpoint   ########################################################
    ####################################################################################################################

    def test_get_review_that_overlaps_default_period(self):
        """Test that a review item that starts during the default period
        but ends after is included in the results."""
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random", now, now + 2)
            response = client.get("/review")
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1

    def test_label_and_zone_filters_match_any_requested_value(self):
        now = datetime.now().timestamp()
        for event_id, data in [
            ("object", {"objects": ["person"], "audio": [], "zones": ["yard"]}),
            ("audio", {"objects": [], "audio": ["bark"], "zones": ["driveway"]}),
            ("other", {"objects": ["car"], "audio": [], "zones": ["street"]}),
        ]:
            super().insert_mock_review_segment(event_id, now - 2, now - 1)
            ReviewSegment.update(data=data).where(
                ReviewSegment.id == event_id
            ).execute()
        with AuthTestClient(self.app) as client:
            response = client.get(
                "/review",
                params={
                    "labels": "person,bark",
                    "zones": "yard,driveway",
                },
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual({row["id"] for row in response.json()}, {"object", "audio"})

    def test_get_review_no_filters(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now - 2, now - 1)
            response = client.get("/review")
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id
            assert response_json[0]["has_been_reviewed"] == False

    def test_get_review_with_time_filter_no_matches(self):
        """Test that review items outside the range are not returned."""
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now - 2, now - 1)
            super().insert_mock_review_segment(f"{id}2", now + 4, now + 5)
            params = {
                "after": now,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 0

    def test_get_review_with_time_filter(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now, now + 2)
            params = {
                "after": now - 1,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id

    def test_get_review_with_limit_filter(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            id2 = "654321.random"
            super().insert_mock_review_segment(id, now, now + 2)
            super().insert_mock_review_segment(id2, now + 1, now + 2)
            params = {
                "limit": 1,
                "after": now,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id2

    def test_get_review_with_severity_filters_no_matches(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now, now + 2, SeverityEnum.detection)
            params = {
                "severity": "detection",
                "after": now - 1,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id

    def test_get_review_with_severity_filters(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now, now + 2, SeverityEnum.detection)
            params = {
                "severity": "alert",
                "after": now - 1,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 0

    def test_get_review_with_all_filters(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now, now + 2)
            params = {
                "cameras": "front_door",
                "labels": "all",
                "zones": "all",
                "reviewed": 0,
                "limit": 1,
                "severity": "alert",
                "after": now - 1,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id

    def test_get_review_with_reviewed_filter_unreviewed(self):
        """Test that reviewed=0 returns only unreviewed items."""
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id_unreviewed = "123456.unreviewed"
            id_reviewed = "123456.reviewed"
            super().insert_mock_review_segment(id_unreviewed, now, now + 2)
            super().insert_mock_review_segment(id_reviewed, now, now + 2)
            self._insert_user_review_status(id_reviewed, reviewed=True)

            params = {
                "reviewed": 0,
                "after": now - 1,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id_unreviewed

    def test_get_review_with_reviewed_filter_reviewed(self):
        """Test that reviewed=1 returns only reviewed items."""
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id_unreviewed = "123456.unreviewed"
            id_reviewed = "123456.reviewed"
            super().insert_mock_review_segment(id_unreviewed, now, now + 2)
            super().insert_mock_review_segment(id_reviewed, now, now + 2)
            self._insert_user_review_status(id_reviewed, reviewed=True)

            params = {
                "reviewed": 1,
                "after": now - 1,
                "before": now + 3,
            }
            response = client.get("/review", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 1
            assert response_json[0]["id"] == id_reviewed

    ####################################################################################################################
    ###################################  GET /review/summary Endpoint   #################################################
    ####################################################################################################################
    def test_get_review_summary_all_filters(self):
        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random")
            params = {
                "cameras": "front_door",
                "labels": "all",
                "zones": "all",
                "timezone": "utc",
            }
            response = client.get("/review/summary", params=params)
            assert response.status_code == 200
            response_json = response.json()
            # e.g. '2024-11-24'
            today_formatted = datetime.today().strftime("%Y-%m-%d")
            expected_response = {
                "last24Hours": {
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
                today_formatted: {
                    "day": today_formatted,
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
            }
            self.assertEqual(response_json, expected_response)

    def test_get_review_summary_no_filters(self):
        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random")
            response = client.get("/review/summary")
            assert response.status_code == 200
            response_json = response.json()
            # e.g. '2024-11-24'
            today_formatted = datetime.today().strftime("%Y-%m-%d")
            expected_response = {
                "last24Hours": {
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
                today_formatted: {
                    "day": today_formatted,
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
            }
            self.assertEqual(response_json, expected_response)

    def test_get_review_summary_multiple_days(self):
        now = datetime.now()
        five_days_ago = datetime.today() - timedelta(days=5)

        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment(
                "123456.random", now.timestamp() - 2, now.timestamp() - 1
            )
            super().insert_mock_review_segment(
                "654321.random",
                five_days_ago.timestamp(),
                five_days_ago.timestamp() + 1,
            )
            response = client.get("/review/summary")
            assert response.status_code == 200
            response_json = response.json()
            # e.g. '2024-11-24'
            today_formatted = now.strftime("%Y-%m-%d")
            # e.g. '2024-11-19'
            five_days_ago_formatted = five_days_ago.strftime("%Y-%m-%d")
            expected_response = {
                "last24Hours": {
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
                today_formatted: {
                    "day": today_formatted,
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
                five_days_ago_formatted: {
                    "day": five_days_ago_formatted,
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
            }
            self.assertEqual(response_json, expected_response)

    def test_get_review_summary_multiple_in_same_day(self):
        now = datetime.now()
        five_days_ago = datetime.today() - timedelta(days=5)

        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random", now.timestamp())
            five_days_ago_ts = five_days_ago.timestamp()
            for i in range(20):
                super().insert_mock_review_segment(
                    f"123456_{i}.random_alert",
                    five_days_ago_ts,
                    five_days_ago_ts,
                    SeverityEnum.alert,
                )
            for i in range(15):
                super().insert_mock_review_segment(
                    f"123456_{i}.random_detection",
                    five_days_ago_ts,
                    five_days_ago_ts,
                    SeverityEnum.detection,
                )
            response = client.get("/review/summary")
            assert response.status_code == 200
            response_json = response.json()
            # e.g. '2024-11-24'
            today_formatted = now.strftime("%Y-%m-%d")
            # e.g. '2024-11-19'
            five_days_ago_formatted = five_days_ago.strftime("%Y-%m-%d")
            expected_response = {
                "last24Hours": {
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
                today_formatted: {
                    "day": today_formatted,
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 1,
                    "total_detection": 0,
                },
                five_days_ago_formatted: {
                    "day": five_days_ago_formatted,
                    "reviewed_alert": 0,
                    "reviewed_detection": 0,
                    "total_alert": 20,
                    "total_detection": 15,
                },
            }
            self.assertEqual(response_json, expected_response)

    def test_get_review_summary_multiple_in_same_day_with_reviewed(self):
        five_days_ago = datetime.today() - timedelta(days=5)

        with AuthTestClient(self.app) as client:
            five_days_ago_ts = five_days_ago.timestamp()
            for i in range(10):
                id = f"123456_{i}.random_alert_not_reviewed"
                super().insert_mock_review_segment(
                    id, five_days_ago_ts, five_days_ago_ts, SeverityEnum.alert
                )
            for i in range(10):
                id = f"123456_{i}.random_alert_reviewed"
                super().insert_mock_review_segment(
                    id, five_days_ago_ts, five_days_ago_ts, SeverityEnum.alert
                )
                self._insert_user_review_status(id, reviewed=True)
            for i in range(10):
                id = f"123456_{i}.random_detection_not_reviewed"
                super().insert_mock_review_segment(
                    id, five_days_ago_ts, five_days_ago_ts, SeverityEnum.detection
                )
            for i in range(5):
                id = f"123456_{i}.random_detection_reviewed"
                super().insert_mock_review_segment(
                    id, five_days_ago_ts, five_days_ago_ts, SeverityEnum.detection
                )
                self._insert_user_review_status(id, reviewed=True)
            response = client.get("/review/summary")
            assert response.status_code == 200
            response_json = response.json()
            # e.g. '2024-11-19'
            five_days_ago_formatted = five_days_ago.strftime("%Y-%m-%d")
            expected_response = {
                "last24Hours": {
                    "reviewed_alert": None,
                    "reviewed_detection": None,
                    "total_alert": None,
                    "total_detection": None,
                },
                five_days_ago_formatted: {
                    "day": five_days_ago_formatted,
                    "reviewed_alert": 10,
                    "reviewed_detection": 5,
                    "total_alert": 20,
                    "total_detection": 15,
                },
            }
            self.assertEqual(response_json, expected_response)

    def test_get_review_summary_days_use_the_same_filters_as_last_24_hours(self):
        now = datetime.now().timestamp()
        segments = {
            "driveway_person": {"objects": ["person"], "zones": ["driveway"]},
            "porch_person": {"objects": ["person"], "zones": ["porch"]},
            "driveway_speech": {"audio": ["speech"], "zones": ["driveway"]},
        }
        for id, data in segments.items():
            super().insert_mock_review_segment(id, now, now + 10, data=data)

        with AuthTestClient(self.app) as client:
            for params, expected in (
                ({"zones": "driveway"}, 2),
                ({"labels": "speech"}, 1),
            ):
                response = client.get(
                    "/review/summary", params={**params, "timezone": "utc"}
                )
                assert response.status_code == 200
                response_json = response.json()
                days = [v for k, v in response_json.items() if k != "last24Hours"]
                assert response_json["last24Hours"]["total_alert"] == expected
                assert sum(day["total_alert"] for day in days) == expected, params

    ####################################################################################################################
    ###################################  POST reviews/viewed Endpoint   ################################################
    ####################################################################################################################

    def test_post_reviews_viewed_no_body(self):
        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random")
            response = client.post("/reviews/viewed")
            # Missing ids
            assert response.status_code == 422

    def test_post_reviews_viewed_no_body_ids(self):
        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random")
            body = {"ids": [""]}
            response = client.post("/reviews/viewed", json=body)
            # Missing ids
            assert response.status_code == 422

    def test_post_reviews_viewed_non_existent_id(self):
        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id)
            body = {"ids": ["1"]}
            response = client.post("/reviews/viewed", json=body)
            assert response.status_code == 200
            response = response.json()
            assert response["success"] == True
            assert response["message"] == "Marked multiple items as reviewed"
            # Verify that in DB the review segment was not changed
            with self.assertRaises(DoesNotExist):
                UserReviewStatus.get(
                    UserReviewStatus.user_id == self.user_id,
                    UserReviewStatus.review_segment == "1",
                )

    def test_post_reviews_viewed(self):
        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id)
            body = {"ids": [id]}
            response = client.post("/reviews/viewed", json=body)
            assert response.status_code == 200
            response_json = response.json()
            assert response_json["success"] == True
            assert response_json["message"] == "Marked multiple items as reviewed"
            # Verify UserReviewStatus was created
            user_review = UserReviewStatus.get(
                UserReviewStatus.user_id == self.user_id,
                UserReviewStatus.review_segment == id,
            )
            assert user_review.has_been_reviewed == True

    ####################################################################################################################
    ###################################  POST reviews/delete Endpoint   ################################################
    ####################################################################################################################
    def test_post_reviews_delete_no_body(self):
        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random")
            response = client.post("/reviews/delete", headers={"remote-role": "admin"})
            # Missing ids
            assert response.status_code == 422

    def test_post_reviews_delete_no_body_ids(self):
        with AuthTestClient(self.app) as client:
            super().insert_mock_review_segment("123456.random")
            body = {"ids": [""]}
            response = client.post(
                "/reviews/delete", json=body, headers={"remote-role": "admin"}
            )
            # Missing ids
            assert response.status_code == 422

    def test_post_reviews_delete_non_existent_id(self):
        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id)
            body = {"ids": ["1"]}
            response = client.post(
                "/reviews/delete", json=body, headers={"remote-role": "admin"}
            )
            assert response.status_code == 200
            response_json = response.json()
            assert response_json["success"] == True
            assert response_json["message"] == "Deleted review items."
            # Verify that in DB the review segment was not deleted
            review_ids_in_db_after = self._get_reviews([id])
            assert len(review_ids_in_db_after) == 1
            assert review_ids_in_db_after[0].id == id

    def test_post_reviews_delete(self):
        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id)
            body = {"ids": [id]}
            response = client.post(
                "/reviews/delete", json=body, headers={"remote-role": "admin"}
            )
            assert response.status_code == 200
            response_json = response.json()
            assert response_json["success"] == True
            assert response_json["message"] == "Deleted review items."
            # Verify that in DB the review segment was deleted
            review_ids_in_db_after = self._get_reviews([id])
            assert len(review_ids_in_db_after) == 0

    def test_post_reviews_delete_many(self):
        with AuthTestClient(self.app) as client:
            ids = ["123456.random", "654321.random"]
            for id in ids:
                super().insert_mock_review_segment(id)
                super().insert_mock_recording(id)

            review_ids_in_db_before = self._get_reviews(ids)
            recordings_ids_in_db_before = self._get_recordings(ids)
            assert len(review_ids_in_db_before) == 2
            assert len(recordings_ids_in_db_before) == 2

            body = {"ids": ids}
            response = client.post(
                "/reviews/delete", json=body, headers={"remote-role": "admin"}
            )
            assert response.status_code == 200
            response_json = response.json()
            assert response_json["success"] == True
            assert response_json["message"] == "Deleted review items."

            # Verify that in DB all review segments and recordings that were passed were deleted
            review_ids_in_db_after = self._get_reviews(ids)
            recording_ids_in_db_after = self._get_recordings(ids)
            assert len(review_ids_in_db_after) == 0
            assert len(recording_ids_in_db_after) == 0

    ####################################################################################################################
    ###################################  GET /review/activity/motion Endpoint   ########################################
    ####################################################################################################################
    def test_review_activity_motion_no_data_for_time_range(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            params = {
                "after": now,
                "before": now + 3,
            }
            response = client.get("/review/activity/motion", params=params)
            assert response.status_code == 200
            response_json = response.json()
            assert len(response_json) == 0

    def test_review_activity_motion(self):
        now = int(datetime.now().timestamp())

        with AuthTestClient(self.app) as client:
            one_m = int((datetime.now() + timedelta(minutes=1)).timestamp())
            id = "123456.random"
            id2 = "123451.random"
            super().insert_mock_recording(id, now + 1, now + 2, motion=101)
            super().insert_mock_recording(id2, one_m + 1, one_m + 2, motion=200)
            params = {
                "after": now,
                "before": one_m + 3,
                "scale": 1,
            }
            response = client.get("/review/activity/motion", params=params)
            assert response.status_code == 200
            response_json = response.json()
            # Only buckets with an actual recording are returned. Empty
            # gap-fill buckets between the two recordings are dropped.
            assert len(response_json) == 2
            self.assertDictEqual(
                {"motion": 50.5, "camera": "front_door", "start_time": now + 1},
                response_json[0],
            )
            self.assertDictEqual(
                {"motion": 100.0, "camera": "front_door", "start_time": one_m + 1},
                response_json[1],
            )

    ####################################################################################################################
    ###################################  GET /review/event/{event_id} Endpoint   #######################################
    ####################################################################################################################
    def test_review_event_not_found(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/review/event/123456.random")
            assert response.status_code == 404
            response_json = response.json()
            self.assertDictEqual(
                {"success": False, "message": "Review item not found"},
                response_json,
            )

    def test_review_event_not_found_in_data(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_review_segment(id, now + 1, now + 2)
            response = client.get(f"/review/event/{id}")
            assert response.status_code == 404
            response_json = response.json()
            self.assertDictEqual(
                {"success": False, "message": "Review item not found"},
                response_json,
            )

    def test_review_get_specific_event(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            event_id = "123456.event.random"
            super().insert_mock_event(event_id)
            review_id = "123456.review.random"
            super().insert_mock_review_segment(
                review_id, now + 1, now + 2, data={"detections": {"event_id": event_id}}
            )
            response = client.get(f"/review/event/{event_id}")
            assert response.status_code == 200
            response_json = response.json()
            self.assertDictEqual(
                {
                    "id": review_id,
                    "camera": "front_door",
                    "start_time": now + 1,
                    "end_time": now + 2,
                    "severity": "alert",
                    "thumb_path": "False",
                    "data": {"detections": {"event_id": event_id}},
                },
                response_json,
            )

    ####################################################################################################################
    ###################################  GET /review/{review_id} Endpoint   #######################################
    ####################################################################################################################
    def test_review_not_found(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/review/123456.random")
            assert response.status_code == 404
            response_json = response.json()
            self.assertDictEqual(
                {"success": False, "message": "Review item not found"},
                response_json,
            )

    def test_get_review(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            review_id = "123456.review.random"
            super().insert_mock_review_segment(review_id, now + 1, now + 2)
            response = client.get(f"/review/{review_id}")
            assert response.status_code == 200
            response_json = response.json()
            self.assertDictEqual(
                {
                    "id": review_id,
                    "camera": "front_door",
                    "start_time": now + 1,
                    "end_time": now + 2,
                    "severity": "alert",
                    "thumb_path": "False",
                    "data": {},
                },
                response_json,
            )

    ####################################################################################################################
    ###################################  DELETE /review/{review_id}/viewed Endpoint   ##################################
    ####################################################################################################################

    def test_delete_review_viewed_review_not_found(self):
        with AuthTestClient(self.app) as client:
            review_id = "123456.random"
            response = client.delete(f"/review/{review_id}/viewed")
            assert response.status_code == 404
            response_json = response.json()
            self.assertDictEqual(
                {"success": False, "message": f"Review {review_id} not found"},
                response_json,
            )

    def test_delete_review_viewed(self):
        now = datetime.now().timestamp()

        with AuthTestClient(self.app) as client:
            review_id = "123456.review.random"
            super().insert_mock_review_segment(review_id, now + 1, now + 2)
            self._insert_user_review_status(review_id, reviewed=True)
            # Verify it’s reviewed before
            response = client.get(f"/review/{review_id}")

            response = client.delete(f"/review/{review_id}/viewed")
            assert response.status_code == 200
            response_json = response.json()
            self.assertDictEqual(
                {"success": True, "message": f"Set Review {review_id} as not viewed"},
                response_json,
            )

            # Verify it’s unreviewed after
            with self.assertRaises(DoesNotExist):
                UserReviewStatus.get(
                    UserReviewStatus.user_id == self.user_id,
                    UserReviewStatus.review_segment == review_id,
                )


class TestHttpReviewBulkDelete(BaseTestHttp):
    """POST /reviews/delete (G14): bounded queries, rows before files."""

    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, UserReviewStatus])
        self.app = super().create_app()
        self.recordings_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.recordings_dir, ignore_errors=True)

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _insert_reviews(
        self, count: int, prefix: str = "review", first_start: float = 10000.0
    ) -> list[str]:
        """Insert reviews 100 s apart, each with one overlapping recording file."""
        ids = [f"{prefix}_{index}" for index in range(count)]
        reviews = []
        recordings = []

        for index, review_id in enumerate(ids):
            start_time = first_start + index * 100
            path = os.path.join(self.recordings_dir, f"{review_id}.mp4")

            with open(path, "w") as f:
                f.write("x")

            reviews.append(
                {
                    "id": review_id,
                    "camera": "front_door",
                    "start_time": start_time,
                    "end_time": start_time + 20,
                    "severity": SeverityEnum.alert,
                    "thumb_path": "",
                    "data": {},
                }
            )
            recordings.append(
                {
                    "id": review_id,
                    "camera": "front_door",
                    "path": path,
                    "start_time": start_time - 5,
                    "end_time": start_time + 5,
                    "duration": 10,
                }
            )

        for start in range(0, count, 100):
            ReviewSegment.insert_many(reviews[start : start + 100]).execute()
            Recordings.insert_many(recordings[start : start + 100]).execute()

        return ids

    def _delete(self, client: AuthTestClient, ids: list[str]):
        response = client.post("/reviews/delete", json={"ids": ids})
        assert response.status_code == 200
        assert response.json() == {
            "success": True,
            "message": "Deleted review items.",
        }

    def _count_statements(self, client: AuthTestClient, ids: list[str]) -> int:
        """Number of SQL statements one bulk delete runs."""
        real_execute_sql = self.db.execute_sql
        statements: list[str] = []

        def counting_execute_sql(sql, *args, **kwargs):
            statements.append(sql)
            return real_execute_sql(sql, *args, **kwargs)

        with patch.object(self.db, "execute_sql", counting_execute_sql):
            self._delete(client, ids)

        return len(statements)

    def test_more_than_a_thousand_ids(self):
        ids = self._insert_reviews(1100)
        kept = self._insert_reviews(2, prefix="kept", first_start=900000.0)
        UserReviewStatus.insert_many(
            [
                {"user_id": "admin", "review_segment": review_id}
                for review_id in (ids[0], ids[-1], kept[0])
            ]
        ).execute()

        with AuthTestClient(self.app) as client:
            self._delete(client, ids)

        assert [row.id for row in ReviewSegment.select()] == kept
        assert [row.id for row in Recordings.select()] == kept
        assert [row.review_segment_id for row in UserReviewStatus.select()] == [kept[0]]
        assert sorted(os.listdir(self.recordings_dir)) == [
            f"{review_id}.mp4" for review_id in kept
        ]

    def test_every_overlap_kind_and_only_the_review_camera(self):
        ReviewSegment.insert(
            id="review",
            camera="front_door",
            start_time=1000,
            end_time=1100,
            severity=SeverityEnum.alert,
            thumb_path="",
            data={},
        ).execute()
        spans = {
            "starts_inside": ("front_door", 1090, 1150),
            "ends_inside": ("front_door", 950, 1010),
            "covers_review": ("front_door", 900, 1200),
            "before": ("front_door", 900, 990),
            "after": ("front_door", 1110, 1200),
            "other_camera": ("back_door", 1000, 1100),
        }
        Recordings.insert_many(
            [
                {
                    "id": recording_id,
                    "camera": camera,
                    "path": os.path.join(self.recordings_dir, recording_id),
                    "start_time": start_time,
                    "end_time": end_time,
                    "duration": end_time - start_time,
                }
                for recording_id, (camera, start_time, end_time) in spans.items()
            ]
        ).execute()

        with AuthTestClient(self.app) as client:
            self._delete(client, ["review", "missing"])

        assert sorted(row.id for row in Recordings.select()) == [
            "after",
            "before",
            "other_camera",
        ]

    def test_survives_a_missing_and_an_undeletable_file(self):
        ids = self._insert_reviews(3)
        os.remove(os.path.join(self.recordings_dir, f"{ids[0]}.mp4"))
        # unlink raises an OSError for a directory
        os.remove(os.path.join(self.recordings_dir, f"{ids[1]}.mp4"))
        os.mkdir(os.path.join(self.recordings_dir, f"{ids[1]}.mp4"))

        with (
            self.assertLogs("frigate.api.fork_bulk", level="WARNING") as logs,
            AuthTestClient(self.app) as client,
        ):
            self._delete(client, ids)

        assert len(logs.records) == 1
        assert logs.records[0].getMessage() == (
            "Unable to delete recording file "
            + os.path.join(self.recordings_dir, f"{ids[1]}.mp4")
        )
        assert ReviewSegment.select().count() == 0
        assert Recordings.select().count() == 0
        # the file after the failed one was still removed
        assert os.listdir(self.recordings_dir) == [f"{ids[1]}.mp4"]

    def test_rows_are_deleted_before_files(self):
        ids = self._insert_reviews(3)
        rows_left_at_unlink: list[int] = []
        real_unlink = Path.unlink

        def recording_unlink(path, *args, **kwargs):
            rows_left_at_unlink.append(
                Recordings.select().count() + ReviewSegment.select().count()
            )
            return real_unlink(path, *args, **kwargs)

        with (
            patch.object(Path, "unlink", recording_unlink),
            AuthTestClient(self.app) as client,
        ):
            self._delete(client, ids)

        assert rows_left_at_unlink == [0, 0, 0]
        assert os.listdir(self.recordings_dir) == []

    def test_statement_count_does_not_follow_reviews(self):
        with AuthTestClient(self.app) as client:
            few = self._count_statements(client, self._insert_reviews(5, "few"))
            many = self._count_statements(client, self._insert_reviews(100, "many"))
            chunks = self._count_statements(client, self._insert_reviews(1100, "big"))

        # per 500 ids: a review SELECT and three DELETEs (recordings, reviews,
        # review status); per 100 reviews: one recordings SELECT
        assert (few, many, chunks) == (5, 5, 3 + 11 + 3 + 6), (few, many, chunks)
