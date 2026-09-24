"""G18: camera access on GET /event_ids and /review_ids after the single query."""

from frigate.models import Event, Recordings, ReviewSegment, UserReviewStatus
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_LIMITED = {"remote-user": "limited", "remote-role": "limited_user"}


class TestIdsCameraAccess(BaseTestHttp):
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
        for id, camera in (
            ("own1", "front_door"),
            ("foreign", "back_door"),
            ("own2", "front_door"),
        ):
            super().insert_mock_event(id, camera=camera)
            super().insert_mock_review_segment(id, camera=camera)

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _get(self, path: str, ids: list[str]):
        with AuthTestClient(self.app) as client:
            return client.get(path, headers=_LIMITED, params={"ids": ",".join(ids)})

    def test_event_ids_returns_accessible_events(self):
        resp = self._get("/event_ids", ["own1", "own2"])

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(sorted(e["id"] for e in resp.json()), ["own1", "own2"])

    def test_event_ids_skips_missing_ids(self):
        resp = self._get("/event_ids", ["own1", "missing"])

        self.assertEqual(resp.status_code, 200)
        self.assertEqual([e["id"] for e in resp.json()], ["own1"])

    def test_event_ids_with_an_inaccessible_id_is_forbidden(self):
        resp = self._get("/event_ids", ["own1", "foreign"])

        self.assertEqual(resp.status_code, 403)

    def test_review_ids_returns_accessible_reviews(self):
        resp = self._get("/review_ids", ["own1", "own2"])

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(sorted(r["id"] for r in resp.json()), ["own1", "own2"])

    def test_review_ids_with_a_missing_id_is_not_found(self):
        resp = self._get("/review_ids", ["own1", "missing"])

        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["message"], "Review missing not found")

    def test_review_ids_with_an_inaccessible_id_is_forbidden(self):
        resp = self._get("/review_ids", ["own1", "foreign"])

        self.assertEqual(resp.status_code, 403)
