"""Camera access on POST /reviews/viewed."""

from frigate.models import Event, Recordings, ReviewSegment, UserReviewStatus
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_LIMITED = {"remote-user": "limited", "remote-role": "limited_user"}


class TestReviewsViewedCameraAccess(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, UserReviewStatus])
        self.minimal_config["auth"] = {"roles": {"limited_user": ["front_door"]}}
        self.minimal_config["cameras"]["back_door"] = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
        }
        self.app = super().create_app()
        super().insert_mock_review_segment("own1", camera="front_door")
        super().insert_mock_review_segment("foreign", camera="back_door")
        super().insert_mock_review_segment("own2", camera="front_door")

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def test_one_inaccessible_id_marks_nothing(self):
        with AuthTestClient(self.app) as client:
            resp = client.post(
                "/reviews/viewed",
                headers=_LIMITED,
                json={"ids": ["own1", "foreign", "own2"], "reviewed": True},
            )

        self.assertEqual(resp.status_code, 403)
        self.assertEqual(UserReviewStatus.select().count(), 0)

    def test_accessible_ids_are_all_marked(self):
        with AuthTestClient(self.app) as client:
            resp = client.post(
                "/reviews/viewed",
                headers=_LIMITED,
                json={"ids": ["own1", "own2"], "reviewed": True},
            )

        self.assertEqual(resp.status_code, 200)
        marked = {
            status.review_segment_id
            for status in UserReviewStatus.select().where(
                UserReviewStatus.user_id == "limited",
                UserReviewStatus.has_been_reviewed == True,  # noqa: E712
            )
        }
        self.assertEqual(marked, {"own1", "own2"})
