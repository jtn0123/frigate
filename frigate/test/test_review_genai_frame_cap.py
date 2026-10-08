"""SV16: bound review image work without changing models or object descriptions."""

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from pydantic import ValidationError

from frigate.config import FrigateConfig
from frigate.config.camera.review import GenAIReviewConfig, ReviewFrameModeEnum
from frigate.data_processing.post import object_descriptions
from frigate.data_processing.post import review_descriptions as module


class TestReviewFrameCapConfig(unittest.TestCase):
    def test_default_and_explicit_null_preserve_existing_budget(self):
        for values in ({}, {"max_frames": None}):
            with self.subTest(values=values):
                config = GenAIReviewConfig(**values)
                self.assertIn("max_frames", config.model_dump())
                self.assertIsNone(config.max_frames)

    def test_accepts_only_integers_from_two_through_twenty_eight(self):
        for value in (2, 6, 28):
            with self.subTest(value=value):
                self.assertEqual(GenAIReviewConfig(max_frames=value).max_frames, value)
        for value in (-1, 0, 1, 29, True, False, 6.0, 6.5, "6", "invalid"):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                GenAIReviewConfig(max_frames=value)

    def test_global_cap_is_inherited_and_camera_override_is_independent(self):
        camera = {
            "ffmpeg": {"inputs": [{"path": "test-stream", "roles": ["detect"]}]},
            "detect": {"width": 1280, "height": 720},
        }
        data = {
            "mqtt": {"enabled": False},
            "models": [{"devices": ["openvino:CPU"]}],
            "ffmpeg": {"hwaccel_args": []},
            "review": {"genai": {"max_frames": 8}},
            "cameras": {
                "front": copy.deepcopy(camera),
                "back": {**camera, "review": {"genai": {"max_frames": 6}}},
            },
        }
        with patch("frigate.detectors.detector_config.load_labels", return_value={}):
            config = FrigateConfig(**data)
        self.assertEqual(config.review.genai.max_frames, 8)
        self.assertEqual(config.cameras["front"].review.genai.max_frames, 8)
        self.assertEqual(config.cameras["back"].review.genai.max_frames, 6)

    def test_cap_does_not_change_stream_commands_recording_or_audio(self):
        data = {
            "mqtt": {"enabled": False},
            "models": [{"devices": ["openvino:CPU"]}],
            "ffmpeg": {"hwaccel_args": []},
            "cameras": {
                "front": {
                    "ffmpeg": {
                        "inputs": [
                            {
                                "path": "test-stream",
                                "roles": ["detect", "record", "audio"],
                            }
                        ]
                    },
                    "audio": {"enabled": True},
                    "detect": {"width": 1280, "height": 720},
                }
            },
        }
        with patch("frigate.detectors.detector_config.load_labels", return_value={}):
            original = FrigateConfig(**data).cameras["front"]
            capped_data = copy.deepcopy(data)
            capped_data["cameras"]["front"]["review"] = {"genai": {"max_frames": 6}}
            capped = FrigateConfig(**capped_data).cameras["front"]
        self.assertEqual(capped.ffmpeg_cmds, original.ffmpeg_cmds)
        self.assertEqual(capped.audio.model_dump(), original.audio.model_dump())
        self.assertEqual(capped.record.model_dump(), original.record.model_dump())


class TestReviewFrameCap(unittest.TestCase):
    def setUp(self):
        self.genai = GenAIReviewConfig(enabled=True)
        self.camera = SimpleNamespace(
            review=SimpleNamespace(genai=self.genai),
            detect=SimpleNamespace(width=1920, height=1080),
            zones={},
            get_formatted_name=lambda: "Front",
        )
        self.processor = object.__new__(module.ReviewDescriptionProcessor)
        self.processor.config = SimpleNamespace(
            cameras={"front": self.camera},
            model_for_camera=lambda camera: SimpleNamespace(
                merged_labelmap={0: "person"}, all_attributes=[]
            ),
            ffmpeg=object(),
        )
        self.client = MagicMock()
        self.client.get_context_size.return_value = 32768
        self.client.estimate_image_tokens.return_value = 1043
        self.client.generate_review_description.return_value = None
        self.processor.genai_manager = SimpleNamespace(description_client=self.client)
        self.processor.requestor = MagicMock()
        self.processor.review_desc_dps = MagicMock()
        self.processor.review_desc_speed = MagicMock()
        self.data = {
            "id": "review1",
            "camera": "front",
            "start_time": 100.0,
            "end_time": 123.0,
            "data": {
                "detections": ["event1"],
                "zones": [],
                "objects": ["person"],
                "sub_labels": [],
                "verified_objects": [],
            },
        }
        self.frames = [(f"frame{i}".encode(), 100.0 + i) for i in range(23)]

    def set_cap(self, value):
        # model_copy also lets the behavioral tests fail before the field exists.
        self.genai = self.genai.model_copy(update={"max_frames": value})
        self.camera.review.genai = self.genai

    def dispatch(self, frames):
        with patch.object(module.threading, "Thread") as thread:
            self.processor.start_analysis(self.camera, self.data, frames)
        target = thread.call_args.kwargs["target"]
        args = thread.call_args.kwargs["args"]
        target(*args)
        return args

    def test_observed_twenty_three_frame_budget_is_capped_in_both_modes(self):
        for mode in ReviewFrameModeEnum:
            with self.subTest(mode=mode):
                self.genai.frame_mode = mode
                self.assertEqual(
                    self.processor.calculate_frame_count("front", 23, frame_mode=mode),
                    23,
                )
                self.set_cap(6)
                self.assertEqual(
                    self.processor.calculate_frame_count("front", 23, frame_mode=mode),
                    6,
                )
                self.set_cap(None)

    def test_cap_never_expands_context_or_duration_budget(self):
        self.set_cap(6)
        self.assertEqual(self.processor.calculate_frame_count("front", 4), 4)
        self.client.get_context_size.return_value = 8272
        self.assertEqual(self.processor.calculate_frame_count("front", 100), 4)
        self.client.get_context_size.return_value = 4100
        self.assertEqual(self.processor.calculate_frame_count("front", 100), 3)

    def test_minimum_two_retains_endpoints_without_a_provider(self):
        self.set_cap(2)
        self.assertEqual(self.processor.calculate_frame_count("front", 23), 2)
        self.processor.genai_manager.description_client = None
        self.assertEqual(self.processor.calculate_frame_count("front", 23), 2)

    def test_no_cap_preserves_plain_and_annotated_existing_limits(self):
        self.set_cap(None)
        self.client.estimate_image_tokens.return_value = 100
        self.assertEqual(self.processor.calculate_frame_count("front", 100), 100)
        self.assertEqual(
            self.processor.calculate_frame_count(
                "front", 100, frame_mode=ReviewFrameModeEnum.annotated_frames
            ),
            28,
        )
        self.processor.genai_manager.description_client = None
        self.assertEqual(self.processor.calculate_frame_count("front", 100), 3)

    def test_provider_handoff_caps_prebuilt_frames_without_mutating_them(self):
        self.set_cap(6)
        original = list(self.frames)
        args = self.dispatch(self.frames)
        images = self.client.generate_review_description.call_args.args[1]
        self.assertEqual(images, [self.frames[i][0] for i in (0, 4, 9, 13, 18, 22)])
        self.assertEqual(len(images), 6)
        self.assertEqual(self.frames, original)
        self.assertIs(args[4], self.data)
        self.assertEqual(self.client.get_context_size.call_count, 0)

    def test_annotated_timestamps_match_the_capped_provider_frames(self):
        self.set_cap(6)
        self.genai.frame_mode = ReviewFrameModeEnum.annotated_frames
        with patch.object(
            module,
            "build_frame_captions",
            return_value=[f"caption{i}" for i in range(6)],
        ) as annotate:
            args = self.dispatch(self.frames)
        annotate.assert_called_once_with(["event1"], [100, 104, 109, 113, 118, 122])
        self.assertEqual(args[6], [f"caption{i}" for i in range(6)])
        self.assertEqual(len(args[5]), len(args[6]))
        self.assertEqual(
            self.client.generate_review_description.call_args.args[-1], args[6]
        )

    def test_empty_and_single_frame_lists_are_not_expanded(self):
        self.set_cap(2)
        for frames in ([], [(b"only", 100.0)]):
            with self.subTest(frames=frames):
                args = self.dispatch(frames)
                self.assertEqual(args[5], [frame for frame, _ in frames])

    def test_unset_cap_preserves_all_available_request_frames(self):
        self.set_cap(None)
        self.dispatch(self.frames)
        self.assertEqual(
            self.client.generate_review_description.call_args.args[1],
            [frame for frame, _ in self.frames],
        )

    def test_uniform_recording_timestamps_cover_uneven_event_durations(self):
        self.set_cap(6)
        query = MagicMock()
        query.where.return_value = query
        query.order_by.return_value = query
        query.limit.return_value = query
        query.get.return_value = SimpleNamespace(path="fixture.mp4", start_time=100)
        for duration in (23.0, 67.3):
            with (
                self.subTest(duration=duration),
                patch.object(module.Recordings, "select", return_value=query),
                patch.object(module, "get_image_from_recording", return_value=b"image"),
            ):
                frames = self.processor.get_recording_frames(
                    "front", 100, 100 + duration
                )
                self.assertEqual(len(frames), 6)
                self.assertAlmostEqual(frames[0][1], 100)
                self.assertAlmostEqual(frames[-1][1], 100 + duration)
                deltas = [frames[i + 1][1] - frames[i][1] for i in range(5)]
                for delta in deltas:
                    self.assertAlmostEqual(delta, duration / 5)

    def test_partial_extraction_failures_do_not_fill_or_expand_the_cap(self):
        self.set_cap(6)
        query = MagicMock()
        query.where.return_value = query
        query.order_by.return_value = query
        query.limit.return_value = query
        query.get.return_value = SimpleNamespace(path="fixture.mp4", start_time=100)

        def extract(_ffmpeg, _path, offset, _format, **_kwargs):
            if 4 <= offset <= 5:
                return None
            if 9 <= offset <= 10:
                raise OSError("fixture extraction failure")
            return f"image{offset}".encode()

        with (
            patch.object(module.Recordings, "select", return_value=query),
            patch.object(module, "get_image_from_recording", side_effect=extract),
            self.assertLogs(module.logger, level="WARNING"),
        ):
            frames = self.processor.get_recording_frames("front", 100, 123)
        self.assertEqual(len(frames), 4)
        self.assertEqual((frames[0][1], frames[-1][1]), (100, 123))
        self.dispatch(frames)
        self.assertEqual(
            len(self.client.generate_review_description.call_args.args[1]), 4
        )

    def test_cached_previews_keep_first_and_last_with_a_two_frame_cap(self):
        self.set_cap(2)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(module, "CACHE_DIR", directory),
        ):
            previews = Path(directory) / "preview_frames"
            previews.mkdir()
            for timestamp in range(100, 124):
                (previews / f"preview_front-{timestamp}.webp").touch()
            frames = self.processor.get_cache_frames("front", 100, 122)
        self.assertEqual([timestamp for _, timestamp in frames], [100, 123])

    def test_twenty_three_available_previews_are_capped_in_both_modes(self):
        self.set_cap(6)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(module, "CACHE_DIR", directory),
        ):
            previews = Path(directory) / "preview_frames"
            previews.mkdir()
            for timestamp in range(100, 123):
                (previews / f"preview_front-{timestamp}.webp").touch()
            for mode in ReviewFrameModeEnum:
                with self.subTest(mode=mode):
                    frames = self.processor.get_cache_frames("front", 100, 122, mode)
                    self.assertEqual(
                        [timestamp for _, timestamp in frames],
                        [100, 104, 109, 113, 118, 122],
                    )

    def test_review_cap_does_not_reduce_object_description_thumbnails(self):
        self.set_cap(2)
        self.camera.objects = SimpleNamespace(
            genai=SimpleNamespace(use_snapshot=False, debug_save_thumbnails=False)
        )
        processor = object.__new__(object_descriptions.ObjectDescriptionProcessor)
        processor.tracked_events = {
            "object1": [{"thumbnail": f"image{i}".encode()} for i in range(10)]
        }
        processor.cleanup_event = MagicMock()
        with (
            patch.object(
                object_descriptions, "ensure_jpeg_bytes", return_value=b"jpeg"
            ),
            patch.object(object_descriptions.threading, "Thread") as thread,
        ):
            processor._process_genai_description(
                SimpleNamespace(id="object1", has_snapshot=False), self.camera, b"jpeg"
            )
        self.assertEqual(len(thread.call_args.kwargs["args"][1]), 10)


class TestUniformReviewFrameSelection(unittest.TestCase):
    def test_uneven_timestamps_keep_order_references_and_endpoints(self):
        from frigate.data_processing.fork.review_frame_cap import limit_review_frames

        frames = [
            (bytearray([i]), timestamp)
            for i, timestamp in enumerate((0, 1, 2, 50, 51, 90, 100))
        ]
        original = list(frames)
        original_bytes = [bytes(frame) for frame, _ in frames]
        selected = limit_review_frames(frames, 4)
        self.assertEqual([timestamp for _, timestamp in selected], [0, 2, 51, 100])
        for selected_frame, original_frame in zip(
            selected, (frames[i] for i in (0, 2, 4, 6))
        ):
            self.assertIs(selected_frame, original_frame)
        self.assertEqual(frames, original)
        self.assertEqual([bytes(frame) for frame, _ in frames], original_bytes)
        self.assertEqual(limit_review_frames(frames, 4), selected)

    def test_empty_single_and_under_cap_are_never_padded(self):
        from frigate.data_processing.fork.review_frame_cap import limit_review_frames

        for frames in ([], [(b"one", 1)], [(b"one", 1), (b"two", 2)]):
            with self.subTest(frames=frames):
                self.assertIs(limit_review_frames(frames, 6), frames)

    def test_unset_cap_returns_the_current_sequence(self):
        from frigate.data_processing.fork.review_frame_cap import limit_review_frames

        frames = [(b"frame", float(i)) for i in range(30)]
        self.assertIs(limit_review_frames(frames, None), frames)

    def test_two_frame_cap_returns_only_the_available_endpoints(self):
        from frigate.data_processing.fork.review_frame_cap import limit_review_frames

        frames = [(b"frame", float(i)) for i in range(23)]
        self.assertEqual(limit_review_frames(frames, 2), [frames[0], frames[-1]])

    def test_invalid_one_frame_limit_cannot_drop_an_endpoint(self):
        from frigate.data_processing.fork.review_frame_cap import limit_review_frames

        with self.assertRaises(ValueError):
            limit_review_frames([(b"first", 1.0), (b"last", 2.0)], 1)


if __name__ == "__main__":
    unittest.main()
