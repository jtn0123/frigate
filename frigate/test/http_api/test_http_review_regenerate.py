"""Tests for the on demand review description and GenAI role endpoints."""

from datetime import datetime
from unittest.mock import MagicMock

from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class TestHttpReviewRegenerateDescription(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        self.minimal_config["cameras"]["front_door"]["review"] = {
            "genai": {"enabled": True}
        }
        self.app = super().create_app()
        self.app.embeddings = MagicMock()
        self.app.genai_manager = MagicMock()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _put(self, review_id: str, role: str = "admin"):
        with AuthTestClient(self.app) as client:
            return client.put(
                f"/review/{review_id}/regenerate_description",
                headers={"remote-user": role, "remote-role": role},
            )

    def test_requests_generation_for_a_finished_item(self):
        now = datetime.now().timestamp()
        super().insert_mock_review_segment("r1", now - 20, now - 5)

        resp = self._put("r1")

        self.assertEqual(resp.status_code, 202)
        self.assertTrue(resp.json()["success"])
        self.app.embeddings.regenerate_review_description.assert_called_once_with("r1")

    def test_missing_item_is_404(self):
        resp = self._put("missing")

        self.assertEqual(resp.status_code, 404)
        self.app.embeddings.regenerate_review_description.assert_not_called()

    def test_item_in_progress_is_rejected(self):
        now = datetime.now().timestamp()
        super().insert_mock_review_segment("r1", now - 20, now - 5)
        ReviewSegment.update(end_time=None).where(ReviewSegment.id == "r1").execute()

        resp = self._put("r1")

        self.assertEqual(resp.status_code, 400)
        self.app.embeddings.regenerate_review_description.assert_not_called()

    def test_camera_without_genai_is_rejected(self):
        now = datetime.now().timestamp()
        super().insert_mock_review_segment("r1", now - 20, now - 5)
        self.app.frigate_config.cameras["front_door"].review.genai.enabled = False

        resp = self._put("r1")

        self.assertEqual(resp.status_code, 400)
        self.app.embeddings.regenerate_review_description.assert_not_called()

    def test_missing_descriptions_provider_is_rejected(self):
        now = datetime.now().timestamp()
        super().insert_mock_review_segment("r1", now - 20, now - 5)
        self.app.genai_manager.description_client = None

        resp = self._put("r1")

        self.assertEqual(resp.status_code, 400)
        self.app.embeddings.regenerate_review_description.assert_not_called()

    def test_viewer_cannot_request_generation(self):
        now = datetime.now().timestamp()
        super().insert_mock_review_segment("r1", now - 20, now - 5)

        resp = self._put("r1", role="viewer")

        self.assertEqual(resp.status_code, 403)
        self.app.embeddings.regenerate_review_description.assert_not_called()

    def test_genai_roles_returns_role_info(self):
        roles = {
            "descriptions": {
                "name": "local",
                "model": "qwen3-vl",
                "context_size": 32768,
            }
        }
        self.app.genai_manager.role_info.return_value = roles

        with AuthTestClient(self.app) as client:
            resp = client.get("/genai/roles")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), roles)
