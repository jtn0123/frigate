"""Exercise review regeneration, annotation dispatch, and frame sampling."""

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import cv2
import numpy as np
from peewee import DoesNotExist

from frigate.config.camera.review import (
    GenAIReviewConfig,
    ImageSourceEnum,
    ReviewFrameModeEnum,
)
from frigate.data_processing.post import review_descriptions as module
from frigate.data_processing.types import PostProcessDataEnum


class TestReviewDescriptionBackport(unittest.TestCase):
    def setUp(self):
        self.genai = GenAIReviewConfig(enabled=True)
        self.camera = SimpleNamespace(
            review=SimpleNamespace(genai=self.genai),
            detect=SimpleNamespace(width=1920, height=1080),
        )
        self.processor = object.__new__(module.ReviewDescriptionProcessor)
        self.processor.config = SimpleNamespace(
            cameras={"front": self.camera},
            model=SimpleNamespace(
                merged_labelmap={0: "person", 1: "car"}, all_attributes=["face"]
            ),
            ffmpeg=object(),
        )
        self.client = MagicMock()
        self.client.get_context_size.return_value = 32000
        self.client.estimate_image_tokens.return_value = 100
        self.processor.genai_manager = SimpleNamespace(description_client=self.client)
        self.processor.metrics = MagicMock()
        self.processor.requestor = MagicMock()
        self.processor.review_desc_dps = MagicMock()
        self.processor.review_desc_speed = MagicMock()
        self.data = {
            "id": "review1",
            "camera": "front",
            "start_time": 100.0,
            "end_time": 104.0,
            "severity": "alert",
            "thumb_path": "fallback.jpg",
            "data": {"detections": ["event1"], "zones": []},
        }
        self.frames = [(b"first", 100.0), (b"last", 104.0)]

    def test_manual_generation_uses_padded_recordings_and_ignores_automatic_toggles(
        self,
    ):
        self.genai.alerts = False
        self.genai.detections = False
        self.genai.debug_save_thumbnails = True
        self.genai.frame_mode = ReviewFrameModeEnum.annotated_frames
        with (
            patch.object(
                module.ReviewSegment,
                "get",
                return_value=SimpleNamespace(camera="front"),
            ),
            patch.object(module, "model_to_dict", return_value=self.data),
            patch.object(
                self.processor, "get_recording_frames", return_value=self.frames
            ) as frames,
            patch.object(self.processor, "save_debug_recording_frames") as debug,
            patch.object(self.processor, "start_analysis") as start,
        ):
            self.processor.regenerate_description("review1")
        frames.assert_called_once_with(
            "front",
            97.0,
            107.0,
            height=480,
            frame_mode=ReviewFrameModeEnum.annotated_frames,
        )
        debug.assert_called_once_with("review1", self.frames)
        start.assert_called_once_with(self.camera, self.data, self.frames)
        self.assertEqual(self.data["start_time"], 100.0)

    def test_manual_generation_rejects_unavailable_inputs(self):
        for condition in (
            "provider",
            "missing",
            "camera",
            "disabled",
            "active",
            "frames",
        ):
            with (
                self.subTest(condition=condition),
                patch.object(
                    module.ReviewSegment,
                    "get",
                    return_value=SimpleNamespace(camera="front"),
                ) as get,
                patch.object(
                    module, "model_to_dict", return_value=copy.deepcopy(self.data)
                ) as convert,
                patch.object(
                    self.processor, "get_recording_frames", return_value=[]
                ) as frames,
                patch.object(self.processor, "start_analysis") as start,
                self.assertLogs(module.logger, level="ERROR"),
            ):
                self.processor.genai_manager.description_client = (
                    None if condition == "provider" else self.client
                )
                self.processor.config.cameras = (
                    {} if condition == "camera" else {"front": self.camera}
                )
                self.genai.enabled = condition != "disabled"
                if condition == "missing":
                    get.side_effect = DoesNotExist
                if condition == "active":
                    convert.return_value["end_time"] = None
                self.processor.regenerate_description("review1")
                start.assert_not_called()
                if condition != "frames":
                    frames.assert_not_called()

    def test_request_starts_a_background_worker_without_extracting_frames_inline(self):
        with patch.object(module.threading, "Thread") as thread:
            result = self.processor.handle_request(
                module.EmbeddingsRequestEnum.regenerate_review_description.value,
                {"review_id": "review1"},
            )
        self.assertEqual(result, "started")
        self.assertIs(thread.call_args.kwargs["target"].__self__, self.processor)
        self.assertEqual(thread.call_args.kwargs["args"], ("review1",))
        self.assertTrue(thread.call_args.kwargs["daemon"])
        thread.return_value.start.assert_called_once()
        self.assertIsNone(self.processor.handle_request("unknown", {}))

    def test_analysis_preserves_frame_order_captions_and_global_labelmap(self):
        for mode, captions in (
            (ReviewFrameModeEnum.frames, []),
            (ReviewFrameModeEnum.annotated_frames, ["person enters", "person leaves"]),
            (ReviewFrameModeEnum.annotated_frames, []),
        ):
            with (
                self.subTest(mode=mode, captions=captions),
                patch.object(
                    module, "build_frame_captions", return_value=captions
                ) as annotate,
                patch.object(module.threading, "Thread") as thread,
            ):
                self.genai.frame_mode = mode
                self.processor.start_analysis(self.camera, self.data, self.frames)
                args = thread.call_args.kwargs["args"]
                self.assertEqual(args[5:7], ([b"first", b"last"], captions))
                self.assertEqual(args[8:], (["car", "person"], ["face"]))
                thread.return_value.start.assert_called_once()
                if mode == ReviewFrameModeEnum.annotated_frames:
                    annotate.assert_called_once_with(["event1"], [100.0, 104.0])
                else:
                    annotate.assert_not_called()

    def test_automatic_generation_selects_recordings_preview_and_fallback(self):
        for source, frames in (
            (ImageSourceEnum.recordings, self.frames),
            (ImageSourceEnum.recordings, []),
            (ImageSourceEnum.preview, []),
        ):
            with (
                self.subTest(source=source, frames=frames),
                patch.object(
                    self.processor, "get_recording_frames", return_value=frames
                ) as recordings,
                patch.object(
                    self.processor,
                    "get_preview_frames_as_bytes",
                    return_value=self.frames,
                ) as previews,
                patch.object(self.processor, "save_debug_recording_frames") as debug,
                patch.object(self.processor, "start_analysis") as start,
            ):
                self.genai.image_source = source
                self.genai.debug_save_thumbnails = True
                self.processor.process_data(
                    {"type": "end", "after": copy.deepcopy(self.data)},
                    PostProcessDataEnum.review,
                )
                start.assert_called_once()
                self.assertEqual(start.call_args.args[2], self.frames)
                self.assertEqual(previews.call_count, int(not frames))
                self.assertEqual(debug.call_count, int(bool(frames)))
                self.assertEqual(
                    recordings.call_count, int(source == ImageSourceEnum.recordings)
                )

    def test_automatic_generation_ignores_removed_cameras(self):
        self.processor.config.cameras = {}
        with patch.object(self.processor, "start_analysis") as start:
            self.processor.process_data(
                {"type": "end", "after": self.data}, PostProcessDataEnum.review
            )
        start.assert_not_called()

    def test_annotation_frame_count_respects_context_duration_and_annotation_cap(self):
        self.assertEqual(
            self.processor.calculate_frame_count(
                "front", 100, frame_mode=ReviewFrameModeEnum.annotated_frames
            ),
            28,
        )
        self.assertEqual(self.processor.calculate_frame_count("front", 7), 7)
        self.client.get_context_size.return_value = 4100
        self.assertEqual(self.processor.calculate_frame_count("front", 100), 3)
        for width, height in ((1080, 1920), (0, 0)):
            self.camera.detect.width, self.camera.detect.height = width, height
            self.processor.calculate_frame_count(
                "front", 10, ImageSourceEnum.recordings
            )
            self.processor.calculate_frame_count("front", 10, ImageSourceEnum.preview)
        self.processor.genai_manager.description_client = None
        self.assertEqual(self.processor.calculate_frame_count("front", 10), 3)

    def test_preview_timestamps_sampling_and_fallback_jpeg_conversion(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(module, "CACHE_DIR", directory),
            patch.object(module, "CLIPS_DIR", directory),
        ):
            previews = Path(directory) / "preview_frames"
            previews.mkdir()
            for timestamp in (99, 100, 101, 102, 103, 104, 105):
                cv2.imwrite(
                    str(previews / f"preview_front-{timestamp}.webp"),
                    np.zeros((8, 8, 3), dtype=np.uint8),
                )
            with patch.object(self.processor, "calculate_frame_count", return_value=3):
                frames = self.processor.get_cache_frames("front", 100, 104)
            self.assertEqual(len(frames), 3)
            self.assertEqual(frames[0][1], 100)
            self.assertEqual(frames[-1][1], 105)
            with patch.object(self.processor, "get_cache_frames", return_value=frames):
                encoded = self.processor.get_preview_frames_as_bytes(
                    "front", 100, 104, "unused", "review1", True
                )
            self.assertEqual([t for _, t in encoded], [t for _, t in frames])
            self.assertTrue(
                (Path(directory) / "genai-requests/review1/0.webp").exists()
            )
            self.processor.save_debug_recording_frames("recording", encoded)
            self.assertEqual(
                (Path(directory) / "genai-requests/recording/0.jpg").read_bytes(),
                encoded[0][0],
            )
            with patch.object(self.processor, "get_cache_frames", return_value=[]):
                fallback = self.processor.get_preview_frames_as_bytes(
                    "front",
                    100,
                    104,
                    str(previews / "preview_front-100.webp"),
                    "review2",
                    False,
                )
                self.assertEqual(fallback[0][1], 100)
                with self.assertLogs(module.logger, level="WARNING"):
                    self.assertEqual(
                        self.processor.get_preview_frames_as_bytes(
                            "front", 100, 104, "missing", "review2", False
                        ),
                        [],
                    )

    def test_recording_extraction_keeps_requested_timestamps_when_rounding(self):
        query = MagicMock()
        query.where.return_value = query
        query.order_by.return_value = query
        query.limit.return_value = query
        query.get.return_value = SimpleNamespace(start_time=100, path="recording.mp4")
        with (
            patch.object(self.processor, "calculate_frame_count", return_value=2),
            patch.object(module.Recordings, "select", return_value=query),
            patch.object(
                module,
                "get_image_from_recording",
                side_effect=[None, b"rounded", b"last"],
            ) as extract,
        ):
            frames = self.processor.get_recording_frames("front", 100.2, 104.2)
        self.assertEqual(frames, [(b"rounded", 100.2), (b"last", 104.2)])
        self.assertEqual(extract.call_args_list[1].args[2], 1)
        with (
            patch.object(self.processor, "calculate_frame_count", return_value=1),
            patch.object(module.Recordings, "select", return_value=query),
            self.assertLogs(module.logger, level="WARNING"),
        ):
            query.get.side_effect = DoesNotExist
            self.assertEqual(self.processor.get_recording_frames("front", 100, 104), [])
