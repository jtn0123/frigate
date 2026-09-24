"""Compatibility and access boundaries for the GenAI backport."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from peewee import DatabaseError, DoesNotExist, IntegrityError

from frigate.api.fork_export_rename import rename_export_file
from frigate.api.review import regenerate_review_description
from frigate.config.classification import AudioTranscriptionConfig
from frigate.util.object_names import get_categorized_object_names


class TestBackportDefaults(unittest.TestCase):
    def test_existing_language_default_and_explicit_auto(self):
        self.assertEqual(AudioTranscriptionConfig().language, "en")
        self.assertEqual(AudioTranscriptionConfig(language="auto").language, "auto")


class TestObjectNameScope(unittest.TestCase):
    @patch("frigate.util.object_names._get_classification_categories")
    def test_custom_names_require_an_accessible_tracked_object(self, categories):
        categories.return_value = {"delivery"}
        config = SimpleNamespace(
            cameras={
                "front": SimpleNamespace(
                    objects=SimpleNamespace(track=["person"]),
                    face_recognition=SimpleNamespace(enabled=False),
                    lpr=SimpleNamespace(enabled=False),
                )
            },
            model=SimpleNamespace(all_attribute_logos=[], attributes_map={}),
            lpr=SimpleNamespace(known_plates={}),
            classification=SimpleNamespace(
                custom={
                    "vehicles": SimpleNamespace(
                        enabled=True,
                        object_config=SimpleNamespace(
                            classification_type="sub_label", objects=["car"]
                        ),
                    )
                }
            ),
        )
        self.assertEqual(get_categorized_object_names(config, []), {})
        self.assertEqual(get_categorized_object_names(config, ["front"]), {})
        config.cameras["front"].objects.track.append("car")
        self.assertEqual(
            get_categorized_object_names(config, ["front"]), {"car": ["delivery"]}
        )


class TestManualReviewGeneration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.review = SimpleNamespace(camera="front", end_time=200)
        self.camera = SimpleNamespace(
            review=SimpleNamespace(genai=SimpleNamespace(enabled=True))
        )
        self.context = MagicMock()
        self.request = SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=SimpleNamespace(cameras={"front": self.camera}),
                genai_manager=SimpleNamespace(description_client=object()),
                embeddings=self.context,
            )
        )
        self.get = patch(
            "frigate.api.review.ReviewSegment.get", return_value=self.review
        )
        self.get.start()
        self.addCleanup(self.get.stop)
        self.access = AsyncMock()
        guard = patch("frigate.api.review.require_camera_access", self.access)
        guard.start()
        self.addCleanup(guard.stop)

    async def test_completed_review_queues_once_after_camera_check(self):
        response = await regenerate_review_description(self.request, "review1")
        self.assertEqual(response.status_code, 202)
        self.access.assert_awaited_once_with("front", request=self.request)
        self.context.regenerate_review_description.assert_called_once_with("review1")

    async def test_denied_camera_never_queues_generation(self):
        self.access.side_effect = HTTPException(status_code=403)
        with self.assertRaises(HTTPException):
            await regenerate_review_description(self.request, "review1")
        self.context.regenerate_review_description.assert_not_called()

    async def test_unavailable_review_or_provider_does_not_queue(self):
        for condition in ("active", "removed", "disabled", "no_provider"):
            with self.subTest(condition=condition):
                self.review.end_time = None if condition == "active" else 200
                self.request.app.frigate_config.cameras = (
                    {} if condition == "removed" else {"front": self.camera}
                )
                self.camera.review.genai.enabled = condition != "disabled"
                self.request.app.genai_manager.description_client = (
                    None if condition == "no_provider" else object()
                )
                response = await regenerate_review_description(self.request, "review1")
                self.assertEqual(response.status_code, 400)
        self.context.regenerate_review_description.assert_not_called()

    async def test_missing_review_returns_404(self):
        with patch("frigate.api.review.ReviewSegment.get", side_effect=DoesNotExist):
            response = await regenerate_review_description(self.request, "missing")
        self.assertEqual(response.status_code, 404)
        self.context.regenerate_review_description.assert_not_called()


class TestExportRenameRollback(unittest.TestCase):
    def test_database_failure_restores_file(self):
        for error, status in ((DatabaseError, 500), (IntegrityError, 409)):
            with self.subTest(error=error):
                export = MagicMock(id="id", video_path="old.mp4", in_progress=False)
                export.save.side_effect = error("write failed")
                with (
                    patch(
                        "frigate.api.fork_export_rename.export_video_path",
                        return_value="new.mp4",
                    ),
                    patch("frigate.api.fork_export_rename.os.rename") as rename,
                    self.assertLogs("frigate.api.fork_export_rename"),
                ):
                    response = rename_export_file(export, "new")
                self.assertEqual(response.status_code, status)
                self.assertEqual(
                    [call.args for call in rename.call_args_list],
                    [("old.mp4", "new.mp4"), ("new.mp4", "old.mp4")],
                )

    def test_failed_move_does_not_save(self):
        export = MagicMock(id="id", video_path="old.mp4", in_progress=False)
        with (
            patch("frigate.api.fork_export_rename.os.rename", side_effect=OSError),
            self.assertLogs("frigate.api.fork_export_rename"),
        ):
            response = rename_export_file(export, "new")
        self.assertEqual(response.status_code, 500)
        export.save.assert_not_called()
