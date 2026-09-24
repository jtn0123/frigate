"""Tests for re-running a review item through GenAI descriptions on demand."""

import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from peewee import DoesNotExist

# Mock TFLite before importing the maintainer
_MOCK_MODULES = [
    "tflite_runtime",
    "tflite_runtime.interpreter",
    "ai_edge_litert",
    "ai_edge_litert.interpreter",
]
for mod in _MOCK_MODULES:
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()

# imported through the maintainer to avoid the circular import between the
# maintainer and the processor modules
from frigate.comms.embeddings_updater import EmbeddingsRequestEnum  # noqa: E402
from frigate.config.camera.genai import GenAIRoleEnum  # noqa: E402
from frigate.config.camera.review import ImageSourceEnum  # noqa: E402
from frigate.data_processing.post import review_descriptions  # noqa: E402
from frigate.data_processing.post.review_descriptions import (  # noqa: E402
    get_recording_buffer_extension,
)
from frigate.data_processing.types import PostProcessDataEnum  # noqa: E402
from frigate.embeddings import EmbeddingsContext  # noqa: E402
from frigate.embeddings.maintainer import ReviewDescriptionProcessor  # noqa: E402
from frigate.genai.manager import GenAIClientManager  # noqa: E402


class TestRecordingBufferExtension(unittest.TestCase):
    def test_long_items_are_capped_at_five_seconds(self):
        self.assertEqual(get_recording_buffer_extension(120), 5)

    def test_medium_items_use_ten_percent(self):
        self.assertAlmostEqual(get_recording_buffer_extension(30), 3)

    def test_short_items_are_padded_to_the_minimum_duration(self):
        # 10% of 4s is 0.4s per side (4.8s total), below the 10s minimum
        self.assertAlmostEqual(get_recording_buffer_extension(4), 3)

    def test_very_short_items_still_cap_at_five_seconds(self):
        self.assertEqual(get_recording_buffer_extension(0), 5)


class TestRegenerateReviewDescription(unittest.TestCase):
    def _make_processor(
        self, genai_enabled: bool = True, client: object | None = "client"
    ) -> ReviewDescriptionProcessor:
        # Bypass the heavy __init__; only the attributes used here are needed
        processor = ReviewDescriptionProcessor.__new__(ReviewDescriptionProcessor)
        camera = MagicMock()
        camera.review.genai.enabled = genai_enabled
        camera.review.genai.debug_save_thumbnails = False
        processor.config = MagicMock()
        processor.config.cameras = {"front": camera}
        processor.genai_manager = MagicMock()
        processor.genai_manager.description_client = (
            MagicMock() if client == "client" else client
        )
        processor.get_recording_frames = MagicMock(return_value=[b"a", b"b"])
        processor.start_analysis = MagicMock()
        processor.save_debug_recording_frames = MagicMock()
        return processor

    def _review(self, camera: str = "front", end_time: float | None = 130.0):
        return SimpleNamespace(camera=camera, end_time=end_time)

    def _run(self, processor, review, data: dict | None = None) -> None:
        if data is None:
            data = {"id": "r1", "start_time": 100.0, "end_time": 130.0}

        with (
            patch.object(review_descriptions.ReviewSegment, "get", return_value=review),
            patch.object(review_descriptions, "model_to_dict", return_value=data),
        ):
            processor.regenerate_description("r1")

    def test_handle_request_starts_a_background_thread(self):
        processor = self._make_processor()

        with patch.object(review_descriptions.threading, "Thread") as thread:
            resp = processor.handle_request(
                EmbeddingsRequestEnum.regenerate_review_description.value,
                {"review_id": "r1"},
            )

        self.assertEqual(resp, "started")
        thread.assert_called_once()
        self.assertEqual(thread.call_args.kwargs["args"], ("r1",))
        self.assertTrue(thread.call_args.kwargs["daemon"])
        thread.return_value.start.assert_called_once()

    def test_runs_analysis_on_padded_recording_frames(self):
        processor = self._make_processor()
        self._run(processor, self._review())

        processor.get_recording_frames.assert_called_once_with(
            "front", 97.0, 133.0, height=480
        )
        processor.start_analysis.assert_called_once()
        camera_config, final_data, thumbs = processor.start_analysis.call_args.args
        self.assertIs(camera_config, processor.config.cameras["front"])
        self.assertEqual(final_data["id"], "r1")
        self.assertEqual(thumbs, [b"a", b"b"])
        processor.save_debug_recording_frames.assert_not_called()

    def test_saves_debug_frames_when_enabled(self):
        processor = self._make_processor()
        processor.config.cameras["front"].review.genai.debug_save_thumbnails = True
        self._run(processor, self._review())

        processor.save_debug_recording_frames.assert_called_once_with(
            "r1", [b"a", b"b"]
        )

    def test_skips_without_a_descriptions_client(self):
        processor = self._make_processor(client=None)
        self._run(processor, self._review())
        processor.start_analysis.assert_not_called()

    def test_skips_a_missing_review(self):
        processor = self._make_processor()

        with patch.object(
            review_descriptions.ReviewSegment, "get", side_effect=DoesNotExist
        ):
            processor.regenerate_description("missing")

        processor.start_analysis.assert_not_called()

    def test_skips_a_removed_camera(self):
        processor = self._make_processor()
        self._run(processor, self._review(camera="gone"))
        processor.start_analysis.assert_not_called()

    def test_skips_when_genai_is_disabled_for_the_camera(self):
        processor = self._make_processor(genai_enabled=False)
        self._run(processor, self._review())
        processor.start_analysis.assert_not_called()

    def test_skips_an_item_that_has_not_ended(self):
        processor = self._make_processor()
        self._run(
            processor,
            self._review(end_time=None),
            {"id": "r1", "start_time": 100.0, "end_time": None},
        )
        processor.get_recording_frames.assert_not_called()
        processor.start_analysis.assert_not_called()

    def test_skips_when_no_recording_frames_exist(self):
        processor = self._make_processor()
        processor.get_recording_frames.return_value = []
        self._run(processor, self._review())
        processor.start_analysis.assert_not_called()


class TestEmbeddingsContextRegenerate(unittest.TestCase):
    def test_request_is_sent_to_the_embeddings_process(self):
        context = EmbeddingsContext.__new__(EmbeddingsContext)
        context.requestor = MagicMock()

        context.regenerate_review_description("r1")

        context.requestor.send_data.assert_called_once_with(
            EmbeddingsRequestEnum.regenerate_review_description.value,
            {"review_id": "r1"},
        )


class TestReviewDescriptionProcessData(unittest.TestCase):
    """The end-of-review path shares its helpers with on demand runs."""

    def _make_processor(self, image_source=ImageSourceEnum.recordings):
        processor = ReviewDescriptionProcessor.__new__(ReviewDescriptionProcessor)
        camera = MagicMock()
        camera.review.genai.enabled = True
        camera.review.genai.alerts = True
        camera.review.genai.detections = True
        camera.review.genai.image_source = image_source
        camera.review.genai.debug_save_thumbnails = False
        processor.config = MagicMock()
        processor.config.cameras = {"front": camera}
        processor.metrics = MagicMock()
        processor.review_desc_dps = MagicMock()
        processor.genai_manager = MagicMock()
        processor.get_recording_frames = MagicMock(return_value=[b"a"])
        processor.get_preview_frames_as_bytes = MagicMock(return_value=[b"p"])
        processor.start_analysis = MagicMock()
        processor.save_debug_recording_frames = MagicMock()
        return processor

    def _end(self, camera: str = "front") -> dict:
        return {
            "type": "end",
            "after": {
                "id": "r1",
                "camera": camera,
                "severity": "alert",
                "start_time": 100.0,
                "end_time": 130.0,
                "thumb_path": "/thumb.webp",
            },
        }

    def test_recordings_are_padded_before_analysis(self):
        processor = self._make_processor()
        processor.config.cameras["front"].review.genai.debug_save_thumbnails = True

        processor.process_data(self._end(), PostProcessDataEnum.review)

        processor.get_recording_frames.assert_called_once_with(
            "front", 97.0, 133.0, height=480
        )
        processor.save_debug_recording_frames.assert_called_once_with("r1", [b"a"])
        camera_config, final_data, thumbs = processor.start_analysis.call_args.args
        self.assertIs(camera_config, processor.config.cameras["front"])
        self.assertEqual((final_data["start_time"], final_data["end_time"]), (97, 133))
        self.assertEqual(thumbs, [b"a"])

    def test_recording_frames_are_not_saved_without_debug(self):
        processor = self._make_processor()

        processor.process_data(self._end(), PostProcessDataEnum.review)

        processor.save_debug_recording_frames.assert_not_called()
        processor.get_preview_frames_as_bytes.assert_not_called()
        self.assertEqual(processor.start_analysis.call_args.args[2], [b"a"])

    def test_preview_frames_are_used_for_the_preview_source(self):
        processor = self._make_processor(image_source=ImageSourceEnum.preview)

        processor.process_data(self._end(), PostProcessDataEnum.review)

        processor.get_recording_frames.assert_not_called()
        processor.start_analysis.assert_called_once()
        self.assertEqual(processor.start_analysis.call_args.args[2], [b"p"])

    def test_start_analysis_runs_in_a_background_thread(self):
        processor = ReviewDescriptionProcessor.__new__(ReviewDescriptionProcessor)
        processor.review_desc_dps = MagicMock()
        processor.requestor = MagicMock()
        processor.review_desc_speed = MagicMock()
        processor.genai_manager = MagicMock()
        processor.config = MagicMock()
        processor.config.model.merged_labelmap = {0: "person", 1: "car"}
        processor.config.model.all_attributes = ["amazon"]
        camera = MagicMock()
        final_data = {"id": "r1"}

        with patch.object(review_descriptions.threading, "Thread") as thread:
            processor.start_analysis(camera, final_data, [b"a"])

        processor.review_desc_dps.update.assert_called_once()
        self.assertIs(
            thread.call_args.kwargs["target"], review_descriptions.run_analysis
        )
        args = thread.call_args.kwargs["args"]
        self.assertIs(args[1], processor.genai_manager.description_client)
        self.assertIs(args[3], camera)
        self.assertIs(args[4], final_data)
        self.assertEqual(args[5], [b"a"])
        self.assertIs(args[6], camera.review.genai)
        self.assertEqual(args[7], ["person", "car"])
        self.assertEqual(args[8], ["amazon"])
        thread.return_value.start.assert_called_once()

    def test_debug_frames_are_written_in_order(self):
        processor = ReviewDescriptionProcessor.__new__(ReviewDescriptionProcessor)

        with tempfile.TemporaryDirectory() as clips:
            with patch.object(review_descriptions, "CLIPS_DIR", clips):
                processor.save_debug_recording_frames("r1", [b"zero", b"one"])

            folder = os.path.join(clips, "genai-requests", "r1")
            self.assertEqual(sorted(os.listdir(folder)), ["0.jpg", "1.jpg"])
            with open(os.path.join(folder, "1.jpg"), "rb") as f:
                self.assertEqual(f.read(), b"one")

    def test_unknown_request_topics_are_ignored(self):
        processor = ReviewDescriptionProcessor.__new__(ReviewDescriptionProcessor)
        self.assertIsNone(processor.handle_request("unknown", {}))

    def test_summary_request_without_described_items(self):
        processor = ReviewDescriptionProcessor.__new__(ReviewDescriptionProcessor)

        with patch.object(review_descriptions.ReviewSegment, "select") as select:
            query = select.return_value.where.return_value.order_by.return_value
            query.dicts.return_value.iterator.return_value = []
            resp = processor.handle_request(
                EmbeddingsRequestEnum.summarize_review.value,
                {"start_ts": 100.0, "end_ts": 200.0},
            )

        self.assertEqual(resp, "No activity was found during this time period.")


class TestGenAIRoleInfo(unittest.TestCase):
    def _make_manager(self) -> GenAIClientManager:
        manager = GenAIClientManager.__new__(GenAIClientManager)
        manager._configs = {
            "local": SimpleNamespace(model="qwen3-vl"),
            "broken": SimpleNamespace(model="missing"),
        }
        manager._role_map = {
            GenAIRoleEnum.descriptions: "local",
            GenAIRoleEnum.chat: "broken",
        }
        manager._clients = {}
        return manager

    def test_reports_model_and_context_size_per_role(self):
        manager = self._make_manager()
        client = MagicMock()
        client.get_context_size.return_value = 32768

        with patch.object(
            manager,
            "_get_client",
            side_effect=lambda name: client if name == "local" else None,
        ):
            info = manager.role_info()

        self.assertEqual(
            info,
            {
                "descriptions": {
                    "name": "local",
                    "model": "qwen3-vl",
                    "context_size": 32768,
                }
            },
        )


if __name__ == "__main__":
    unittest.main()
