"""Coverage for the embeddings maintainer (fork D73).

Builds EmbeddingMaintainer with every ZMQ subscriber, publisher, requestor,
database, GenAI manager and embeddings model patched out, and the processor
classes reduced to empty constructors so isinstance checks still work. The
handler methods are then driven directly; run() is only called with a stop
event that ends the loop after at most one iteration.
"""

import base64
import json
import sys
import threading
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call, patch

import numpy as np
from peewee import DoesNotExist

# Mock TFLite before importing the maintainer
for _mod in (
    "tflite_runtime",
    "tflite_runtime.interpreter",
    "ai_edge_litert",
    "ai_edge_litert.interpreter",
):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

from frigate.embeddings import maintainer as maintainer_module  # noqa: E402
from frigate.embeddings.maintainer import (  # noqa: E402
    AudioTranscriptionPostProcessor,
    BirdRealTimeProcessor,
    CameraTypeEnum,
    CustomObjectClassificationProcessor,
    CustomStateClassificationProcessor,
    EmbeddingMaintainer,
    EmbeddingsRequestEnum,
    EventMetadataTypeEnum,
    EventStateEnum,
    EventTypeEnum,
    FaceRealTimeProcessor,
    LicensePlatePostProcessor,
    LicensePlateRealTimeProcessor,
    ObjectClassificationType,
    ObjectDescriptionProcessor,
    PostProcessDataEnum,
    RegenerateDescriptionEnum,
    ReviewDescriptionProcessor,
    SemanticTriggerProcessor,
    TrackedObjectUpdateTypesEnum,
)
from frigate.models import (  # noqa: E402
    Event,
    Recordings,
    ReviewSegment,
    Timeline,
    Trigger,
)

CAMERA = "front"
FRAME_SHAPE = (540, 640)

# collaborators replaced by MagicMock classes in the maintainer namespace
PATCHED_NAMES = (
    "CameraConfigUpdateSubscriber",
    "ConfigSubscriber",
    "SqliteVecQueueDatabase",
    "GenAIClientManager",
    "Embeddings",
    "InterProcessRequestor",
    "EventUpdateSubscriber",
    "EventEndSubscriber",
    "EventMetadataPublisher",
    "EventMetadataSubscriber",
    "RecordingsDataSubscriber",
    "ReviewDataSubscriber",
    "DetectionSubscriber",
    "EmbeddingsResponder",
    "SharedMemoryFrameManager",
    "LicensePlateModelRunner",
)

# processor classes keep their identity (for isinstance) but get an empty
# constructor so no models, threads or sockets are created
PROCESSOR_CLASSES = (
    FaceRealTimeProcessor,
    BirdRealTimeProcessor,
    LicensePlateRealTimeProcessor,
    CustomStateClassificationProcessor,
    CustomObjectClassificationProcessor,
    LicensePlatePostProcessor,
    AudioTranscriptionPostProcessor,
    SemanticTriggerProcessor,
    ReviewDescriptionProcessor,
    ObjectDescriptionProcessor,
)


def make_camera(
    name: str = CAMERA,
    enabled: bool = True,
    audio: bool = False,
    review_genai: bool = False,
    object_genai: bool = False,
    type: CameraTypeEnum = CameraTypeEnum.generic,
    track: tuple[str, ...] = ("person",),
    expire_time: int = 3,
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        enabled=enabled,
        enabled_in_config=enabled,
        audio_transcription=SimpleNamespace(enabled=audio),
        review=SimpleNamespace(
            genai=SimpleNamespace(enabled=review_genai, enabled_in_config=False)
        ),
        objects=SimpleNamespace(
            genai=SimpleNamespace(enabled=object_genai, enabled_in_config=False),
            track=list(track),
        ),
        type=type,
        frame_shape_yuv=FRAME_SHAPE,
        lpr=SimpleNamespace(expire_time=expire_time),
    )


def make_model(name: str, enabled: bool = True, state: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        name=name, enabled=enabled, state_config=object() if state else None
    )


def make_config(
    semantic: bool = False,
    reindex: bool = False,
    lpr: bool = False,
    face: bool = False,
    bird: bool = False,
    custom: dict[str, Any] | None = None,
    cameras: dict[str, Any] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        cameras=cameras if cameras is not None else {CAMERA: make_camera()},
        database=SimpleNamespace(path="/tmp/frigate-test.db"),
        semantic_search=SimpleNamespace(enabled=semantic, reindex=reindex),
        lpr=SimpleNamespace(enabled=lpr, device="CPU", model_size="small"),
        face_recognition=SimpleNamespace(enabled=face),
        classification=SimpleNamespace(
            bird=SimpleNamespace(enabled=bird), custom=custom or {}
        ),
        genai=None,
    )


class MaintainerMixin(unittest.TestCase):
    """Patch the maintainer's collaborators for the duration of each test."""

    def setUp(self) -> None:
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.mocks: dict[str, MagicMock] = {
            name: stack.enter_context(patch.object(maintainer_module, name))
            for name in PATCHED_NAMES
        }
        self.inits: dict[type, MagicMock] = {
            cls: stack.enter_context(patch.object(cls, "__init__", return_value=None))
            for cls in PROCESSOR_CLASSES
        }
        self.metrics = SimpleNamespace(runtime_devices={})
        self.stop_event = threading.Event()

    def build(self, config: SimpleNamespace | None = None) -> EmbeddingMaintainer:
        return EmbeddingMaintainer(
            config or make_config(), self.metrics, self.stop_event
        )


class TestConstructor(MaintainerMixin):
    def test_minimal_config_creates_no_processors(self) -> None:
        m = self.build()

        self.assertIsNone(m.embeddings)
        self.assertEqual(m.realtime_processors, [])
        self.assertEqual(m.post_processors, [])
        self.assertIsNone(m.semantic_trigger_processor)
        self.assertEqual(m.recordings_available_through, {})
        self.assertIs(m.stop_event, self.stop_event)
        self.mocks["Embeddings"].assert_not_called()
        self.mocks["LicensePlateModelRunner"].assert_not_called()

        db = self.mocks["SqliteVecQueueDatabase"]
        self.assertEqual(db.call_args.kwargs["timeout"], 60)
        self.assertTrue(db.call_args.kwargs["load_vec_extension"])
        db.return_value.bind.assert_called_once_with(
            [Event, Recordings, ReviewSegment, Timeline, Trigger]
        )
        self.mocks["EventMetadataSubscriber"].assert_called_once_with(
            EventMetadataTypeEnum.regenerate_description
        )

    def test_database_timeout_scales_with_enabled_cameras(self) -> None:
        cameras = {f"cam{i}": make_camera(f"cam{i}") for i in range(8)}
        cameras["off"] = make_camera("off", enabled=False)

        self.build(make_config(cameras=cameras))

        self.assertEqual(
            self.mocks["SqliteVecQueueDatabase"].call_args.kwargs["timeout"], 80
        )

    def test_full_config_registers_every_processor(self) -> None:
        cameras = {
            CAMERA: make_camera(audio=True, review_genai=True),
            "back": make_camera("back", object_genai=True),
        }
        config = make_config(
            semantic=True,
            reindex=True,
            lpr=True,
            face=True,
            bird=True,
            custom={
                "door": make_model("door", state=True),
                "dog": make_model("dog"),
                "off": make_model("off", enabled=False),
            },
            cameras=cameras,
        )

        m = self.build(config)

        embeddings = self.mocks["Embeddings"].return_value
        self.assertIs(m.embeddings, embeddings)
        embeddings.reindex.assert_called_once_with()
        embeddings.sync_triggers.assert_called_once_with()
        self.assertEqual(
            [type(p) for p in m.realtime_processors],
            [
                FaceRealTimeProcessor,
                BirdRealTimeProcessor,
                LicensePlateRealTimeProcessor,
                CustomStateClassificationProcessor,
                CustomObjectClassificationProcessor,
            ],
        )
        self.assertEqual(
            [type(p) for p in m.post_processors],
            [
                LicensePlatePostProcessor,
                AudioTranscriptionPostProcessor,
                SemanticTriggerProcessor,
                ReviewDescriptionProcessor,
                ObjectDescriptionProcessor,
            ],
        )
        self.assertIs(m.semantic_trigger_processor, m.post_processors[2])

        runner = self.mocks["LicensePlateModelRunner"]
        runner.assert_called_once_with(m.requestor, device="CPU", model_size="small")
        lpr_args = self.inits[LicensePlateRealTimeProcessor].call_args.args
        self.assertIs(lpr_args[4], runner.return_value)
        self.assertIs(lpr_args[5], m.detected_license_plates)
        # the object description processor is wired to the trigger processor
        self.assertIs(
            self.inits[ObjectDescriptionProcessor].call_args.args[5],
            m.semantic_trigger_processor,
        )

    def test_semantic_search_without_reindex_only_syncs_triggers(self) -> None:
        self.build(make_config(semantic=True))

        embeddings = self.mocks["Embeddings"].return_value
        embeddings.reindex.assert_not_called()
        embeddings.sync_triggers.assert_called_once_with()


class TestRun(MaintainerMixin):
    STEPS = (
        "_check_camera_config_updates",
        "_check_enrichment_config_updates",
        "_process_requests",
        "_process_updates",
        "_process_recordings_updates",
        "_process_review_updates",
        "_process_frame_updates",
        "_process_deferred_results",
        "_expire_dedicated_lpr",
        "_process_finalized",
        "_process_event_metadata",
        "_publish_runtime_devices",
    )

    def test_preset_stop_event_shuts_everything_down(self) -> None:
        m = self.build()
        processor = MagicMock()
        m.realtime_processors = [processor]
        self.stop_event.set()

        with self.assertLogs(maintainer_module.logger, "INFO") as logs:
            m.run()

        processor.shutdown.assert_called_once_with()
        for name in (
            "config_updater",
            "enrichment_config_subscriber",
            "event_subscriber",
            "event_end_subscriber",
            "recordings_subscriber",
            "detection_subscriber",
            "event_metadata_publisher",
            "event_metadata_subscriber",
            "embeddings_responder",
            "requestor",
        ):
            getattr(m, name).stop.assert_called_once_with()
        self.assertIn("Exiting embeddings maintenance", logs.output[-1])

    def test_one_iteration_runs_every_step(self) -> None:
        m = self.build()
        m.stop_event = MagicMock()
        m.stop_event.is_set.side_effect = [False, True]

        with ExitStack() as stack:
            steps = {
                name: stack.enter_context(patch.object(m, name)) for name in self.STEPS
            }
            m.run()

        for name, step in steps.items():
            step.assert_called_once_with()


class TestConfigUpdates(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()
        self.realtime = MagicMock()
        self.post = MagicMock()
        self.m.realtime_processors = [self.realtime]
        self.m.post_processors = [self.post]

    def test_genai_topics_resync_processors(self) -> None:
        self.m.config_updater.check_for_updates.return_value = {"objects": [CAMERA]}

        with patch.object(self.m, "_sync_genai_processors") as sync:
            self.m._check_camera_config_updates()

        sync.assert_called_once_with()

    def test_other_topics_do_not_resync(self) -> None:
        self.m.config_updater.check_for_updates.return_value = {"motion": [CAMERA]}

        with patch.object(self.m, "_sync_genai_processors") as sync:
            self.m._check_camera_config_updates()

        sync.assert_not_called()

    def test_runtime_genai_enable_adds_processor(self) -> None:
        self.m.post_processors = []
        self.m.config.cameras[CAMERA].review.genai.enabled = True
        self.m.config_updater.check_for_updates.return_value = {"review_genai": []}

        self.m._check_camera_config_updates()

        self.assertEqual(
            [type(p) for p in self.m.post_processors], [ReviewDescriptionProcessor]
        )

    def test_no_enrichment_update(self) -> None:
        self.m.enrichment_config_subscriber.check_for_update.return_value = (
            None,
            None,
        )

        self.m._check_enrichment_config_updates()

        self.realtime.update_config.assert_not_called()

    def test_custom_classification_topic_is_delegated(self) -> None:
        model = make_model("door")
        self.m.enrichment_config_subscriber.check_for_update.return_value = (
            "config/classification/custom/door",
            model,
        )

        with patch.object(self.m, "_handle_custom_classification_update") as handle:
            self.m._check_enrichment_config_updates()

        handle.assert_called_once_with("config/classification/custom/door", model)
        self.realtime.update_config.assert_not_called()

    def test_genai_topic_updates_manager_and_broadcasts(self) -> None:
        payload = {"provider": "x"}
        self.m.enrichment_config_subscriber.check_for_update.return_value = (
            "config/genai",
            payload,
        )

        self.m._check_enrichment_config_updates()

        self.assertIs(self.m.config.genai, payload)
        self.m.genai_manager.update_config.assert_called_once_with(self.m.config)
        self.realtime.update_config.assert_called_once_with("config/genai", payload)
        self.post.update_config.assert_called_once_with("config/genai", payload)

    def test_other_topic_only_broadcasts(self) -> None:
        self.m.enrichment_config_subscriber.check_for_update.return_value = (
            "config/lpr",
            {"enabled": True},
        )

        self.m._check_enrichment_config_updates()

        self.m.genai_manager.update_config.assert_not_called()
        self.realtime.update_config.assert_called_once_with(
            "config/lpr", {"enabled": True}
        )
        self.post.update_config.assert_called_once()


class TestCustomClassificationUpdates(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()

    def existing(self, cls: type, name: str) -> MagicMock:
        processor = MagicMock(spec=cls)
        processor.model_config = make_model(name)
        return processor

    def test_removal_shuts_down_matching_processor(self) -> None:
        door = self.existing(CustomStateClassificationProcessor, "door")
        dog = self.existing(CustomObjectClassificationProcessor, "dog")
        other = MagicMock()
        self.m.realtime_processors = [door, dog, other]

        with self.assertLogs(maintainer_module.logger, "INFO") as logs:
            self.m._handle_custom_classification_update(
                "config/classification/custom/door", None
            )

        door.shutdown.assert_called_once_with()
        self.assertEqual(self.m.realtime_processors, [dog, other])
        self.assertIn("Successfully removed", logs.output[0])

    def test_adds_state_processor(self) -> None:
        model = make_model("door", state=True)

        self.m._handle_custom_classification_update(
            "config/classification/custom/door", model
        )

        self.assertIs(self.m.config.classification.custom["door"], model)
        self.assertEqual(len(self.m.realtime_processors), 1)
        self.assertIsInstance(
            self.m.realtime_processors[0], CustomStateClassificationProcessor
        )
        self.inits[CustomStateClassificationProcessor].assert_called_once_with(
            self.m.config, model, self.m.requestor, self.metrics
        )

    def test_adds_object_processor(self) -> None:
        model = make_model("dog")

        self.m._handle_custom_classification_update(
            "config/classification/custom/dog", model
        )

        self.assertIsInstance(
            self.m.realtime_processors[0], CustomObjectClassificationProcessor
        )
        self.inits[CustomObjectClassificationProcessor].assert_called_once_with(
            self.m.config,
            model,
            self.m.event_metadata_publisher,
            self.m.requestor,
            self.metrics,
        )

    def test_updates_existing_processor_config(self) -> None:
        dog = self.existing(CustomObjectClassificationProcessor, "dog")
        self.m.realtime_processors = [MagicMock(), dog]
        model = make_model("dog")

        self.m._handle_custom_classification_update(
            "config/classification/custom/dog", model
        )

        self.assertIs(dog.model_config, model)
        self.assertEqual(len(self.m.realtime_processors), 2)
        self.inits[CustomObjectClassificationProcessor].assert_not_called()


class TestProcessRequests(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()
        self.m.embeddings = MagicMock()
        self.m.config.semantic_search.enabled = True

    def request(self, topic: str, data: Any) -> Any:
        results = []
        self.m.embeddings_responder.check_for_request.side_effect = lambda handler: (
            results.append(handler(topic, data))
        )
        self.m._process_requests()
        return results[0]

    def test_embed_description(self) -> None:
        self.m.embeddings.embed_description.return_value = np.array([0.5, 1.0])

        result = self.request(
            EmbeddingsRequestEnum.embed_description.value,
            {"id": "ev1", "description": "a dog"},
        )

        self.assertEqual(result, [0.5, 1.0])
        self.m.embeddings.embed_description.assert_called_once_with("ev1", "a dog")

    def test_embed_thumbnail_decodes_base64(self) -> None:
        self.m.embeddings.embed_thumbnail.return_value = np.array([2.0])

        result = self.request(
            EmbeddingsRequestEnum.embed_thumbnail.value,
            {"id": "ev1", "thumbnail": base64.b64encode(b"jpeg").decode()},
        )

        self.assertEqual(result, [2.0])
        self.m.embeddings.embed_thumbnail.assert_called_once_with("ev1", b"jpeg")

    def test_generate_search_does_not_upsert(self) -> None:
        self.m.embeddings.embed_description.return_value = np.array([3.0])

        result = self.request(EmbeddingsRequestEnum.generate_search.value, "cats")

        self.assertEqual(result, [3.0])
        self.m.embeddings.embed_description.assert_called_once_with(
            "", "cats", upsert=False
        )

    def test_reindex_reports_started_or_in_progress(self) -> None:
        self.m.embeddings.start_reindex.return_value = True
        self.assertEqual(
            self.request(EmbeddingsRequestEnum.reindex.value, {}), "started"
        )

        self.m.embeddings.start_reindex.return_value = False
        self.assertEqual(
            self.request(EmbeddingsRequestEnum.reindex.value, {}), "in_progress"
        )

    def test_other_topics_go_to_processors_in_order(self) -> None:
        self.m.config.semantic_search.enabled = False
        silent = MagicMock()
        silent.handle_request.return_value = None
        answering = MagicMock()
        answering.handle_request.return_value = {"success": True}
        never = MagicMock()
        self.m.realtime_processors = [silent]
        self.m.post_processors = [answering, never]

        result = self.request(EmbeddingsRequestEnum.reprocess_plate.value, {"x": 1})

        self.assertEqual(result, {"success": True})
        silent.handle_request.assert_called_once_with("reprocess_plate", {"x": 1})
        never.handle_request.assert_not_called()

    def test_unhandled_topic_logs_error(self) -> None:
        with self.assertLogs(maintainer_module.logger, "ERROR") as logs:
            result = self.request("unknown_topic", {})

        self.assertIsNone(result)
        self.assertIn("No processor handled the topic unknown_topic", logs.output[0])

    def test_handler_exception_is_logged(self) -> None:
        self.m.embeddings.embed_description.side_effect = RuntimeError("model down")

        with self.assertLogs(maintainer_module.logger, "ERROR") as logs:
            result = self.request(
                EmbeddingsRequestEnum.embed_description.value,
                {"id": "ev1", "description": "x"},
            )

        self.assertIsNone(result)
        self.assertIn("Unable to handle embeddings request", logs.output[0])


class TestProcessUpdates(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()
        self.frame = np.zeros(FRAME_SHAPE, np.uint8)
        self.m.frame_manager.get.return_value = self.frame
        self.realtime = MagicMock()
        self.describer = MagicMock(spec=ObjectDescriptionProcessor)
        self.trigger = MagicMock(spec=SemanticTriggerProcessor)
        self.m.realtime_processors = [self.realtime]
        self.m.post_processors = [self.describer, self.trigger]
        self.data = {"id": "ev1", "label": "person"}

    def update(
        self,
        source: Any = EventTypeEnum.tracked_object,
        state: EventStateEnum = EventStateEnum.update,
        camera: str = CAMERA,
    ) -> None:
        self.m.event_subscriber.check_for_update.return_value = (
            source,
            state,
            camera,
            "frame1",
            self.data,
        )
        self.m._process_updates()

    def test_no_update(self) -> None:
        self.m.event_subscriber.check_for_update.return_value = None

        self.m._process_updates()

        self.m.frame_manager.get.assert_not_called()

    def test_skips_non_tracked_object_sources(self) -> None:
        self.update(source=EventTypeEnum.api)
        self.update(camera="")

        self.m.frame_manager.get.assert_not_called()

    def test_unknown_camera_still_updates_stats(self) -> None:
        self.m.config.semantic_search.enabled = True
        self.m.embeddings = MagicMock()

        self.update(camera="gone")

        self.m.embeddings.update_stats.assert_called_once_with()
        self.m.frame_manager.get.assert_not_called()

    def test_no_processors_skips_frame_fetch(self) -> None:
        self.m.realtime_processors = []
        self.m.post_processors = []

        self.update()

        self.m.frame_manager.get.assert_not_called()

    def test_missing_frame_is_skipped(self) -> None:
        self.m.frame_manager.get.return_value = None

        self.update()

        self.realtime.process_frame.assert_not_called()
        self.m.frame_manager.close.assert_not_called()

    def test_frame_not_found_error(self) -> None:
        self.m.frame_manager.get.side_effect = FileNotFoundError

        # Upstream bug: _process_updates catches FileNotFoundError from
        # frame_manager.get but never assigns yuv_frame, so the following
        # "if yuv_frame is None" raises UnboundLocalError. It is latent today
        # because SharedMemoryFrameManager.get already returns None on a
        # missing segment; setting yuv_frame = None in the except would fix it.
        with self.assertRaises(UnboundLocalError):
            self.update()

    def test_update_feeds_realtime_and_description_processors(self) -> None:
        self.update()

        self.m.frame_manager.get.assert_called_once_with("frame1", FRAME_SHAPE)
        self.realtime.process_frame.assert_called_once_with(self.data, self.frame)
        self.describer.process_data.assert_called_once_with(
            {
                "camera": CAMERA,
                "data": self.data,
                "state": "update",
                "yuv_frame": self.frame,
            },
            PostProcessDataEnum.tracked_object,
        )
        self.trigger.process_data.assert_not_called()
        self.m.frame_manager.close.assert_called_once_with("frame1")

    def test_end_events_skip_description_processor(self) -> None:
        self.update(state=EventStateEnum.end)

        self.realtime.process_frame.assert_called_once()
        self.describer.process_data.assert_not_called()
        self.m.frame_manager.close.assert_called_once_with("frame1")


class TestProcessFinalized(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()
        self.realtime = MagicMock()
        self.lpr = MagicMock(spec=LicensePlatePostProcessor)
        self.audio = MagicMock(spec=AudioTranscriptionPostProcessor)
        self.trigger = MagicMock(spec=SemanticTriggerProcessor)
        self.describer = MagicMock(spec=ObjectDescriptionProcessor)
        self.review = MagicMock(spec=ReviewDescriptionProcessor)
        self.m.realtime_processors = [self.realtime]
        self.m.post_processors = [
            self.lpr,
            self.audio,
            self.trigger,
            self.describer,
            self.review,
        ]
        self.event = SimpleNamespace(id="ev1", data={"type": "object"})
        self.get = self.enterContext(patch.object(maintainer_module.Event, "get"))
        self.get.return_value = self.event
        self.thumb = self.enterContext(
            patch.object(
                maintainer_module, "get_event_thumbnail_bytes", return_value=b"jpg"
            )
        )

    def finalize(self, *ended: tuple[str, str, bool]) -> None:
        self.m.event_end_subscriber.check_for_update.side_effect = [*ended, None]
        self.m._process_finalized()

    def test_missing_event_only_cleans_up(self) -> None:
        self.get.side_effect = DoesNotExist

        self.finalize(("ev1", CAMERA, True))

        self.realtime.expire_object.assert_called_once_with("ev1", CAMERA)
        self.describer.cleanup_event.assert_called_once_with("ev1")
        self.trigger.process_data.assert_not_called()

    def test_non_object_event_only_cleans_up(self) -> None:
        self.event.data = {"type": "audio"}

        self.finalize(("ev1", CAMERA, True))

        self.describer.cleanup_event.assert_called_once_with("ev1")
        self.describer.process_data.assert_not_called()
        self.thumb.assert_not_called()

    def test_object_event_runs_every_post_processor(self) -> None:
        self.m.config.semantic_search.enabled = True
        self.m.embeddings = MagicMock()
        self.m.recordings_available_through[CAMERA] = 50.0
        self.m.detected_license_plates["ev1"] = {"obj_data": {"plate": "ABC"}}

        self.finalize(("ev1", CAMERA, True))

        self.m.embeddings.embed_thumbnail.assert_called_once_with("ev1", b"jpg")
        self.lpr.process_data.assert_called_once_with(
            {
                "event_id": "ev1",
                "camera": CAMERA,
                "recordings_available": 50.0,
                "obj_data": {"plate": "ABC"},
            },
            PostProcessDataEnum.recording,
        )
        self.audio.process_data.assert_not_called()
        self.trigger.process_data.assert_called_once_with(
            {"event_id": "ev1", "camera": CAMERA, "type": "image"},
            PostProcessDataEnum.tracked_object,
        )
        self.describer.process_data.assert_called_once_with(
            {
                "event": self.event,
                "camera": CAMERA,
                "state": "finalize",
                "thumbnail": b"jpg",
            },
            PostProcessDataEnum.tracked_object,
        )
        self.review.process_data.assert_called_once_with(
            {"event_id": "ev1", "camera": CAMERA},
            PostProcessDataEnum.tracked_object,
        )

    def test_dedicated_lpr_camera_skips_recording_reprocess(self) -> None:
        self.m.config.cameras[CAMERA].type = "lpr"
        self.m.recordings_available_through[CAMERA] = 50.0
        self.m.detected_license_plates["ev1"] = {"obj_data": {}}

        self.finalize(("ev1", CAMERA, True))

        self.lpr.process_data.assert_not_called()

    def test_not_updated_db_cleans_up_description_state(self) -> None:
        self.finalize(("ev1", CAMERA, False))

        self.get.assert_not_called()
        self.lpr.process_data.assert_not_called()
        self.describer.cleanup_event.assert_called_once_with("ev1")
        self.describer.process_data.assert_not_called()
        self.trigger.process_data.assert_called_once()

    def test_removed_camera_cleans_up(self) -> None:
        self.finalize(("ev1", "gone", True))

        self.describer.cleanup_event.assert_called_once_with("ev1")
        self.trigger.process_data.assert_not_called()

    def test_drains_every_queued_event(self) -> None:
        self.finalize(("ev1", CAMERA, False), ("ev2", CAMERA, False))

        self.assertEqual(
            self.realtime.expire_object.call_args_list,
            [call("ev1", CAMERA), call("ev2", CAMERA)],
        )


class TestEmbedThumbnail(MaintainerMixin):
    def test_disabled_semantic_search_is_noop(self) -> None:
        m = self.build()
        m.embeddings = MagicMock()

        m._embed_thumbnail("ev1", b"jpg")

        m.embeddings.embed_thumbnail.assert_not_called()

    def test_value_error_is_logged(self) -> None:
        m = self.build()
        m.config.semantic_search.enabled = True
        m.embeddings = MagicMock()
        m.embeddings.embed_thumbnail.side_effect = ValueError("bad image")

        with self.assertLogs(maintainer_module.logger, "WARNING") as logs:
            m._embed_thumbnail("ev1", b"jpg")

        self.assertIn("Failed to embed thumbnail for event ev1", logs.output[0])


class TestExpireDedicatedLpr(MaintainerMixin):
    def test_expires_stale_and_orphaned_plates(self) -> None:
        m = self.build()
        m.detected_license_plates.update(
            {
                "orphan": {"camera": "gone", "last_seen": 99.0},
                "unseen": {"camera": CAMERA},
                "stale": {"camera": CAMERA, "last_seen": 90.0},
                "fresh": {"camera": CAMERA, "last_seen": 98.0},
            }
        )

        with patch.object(maintainer_module, "datetime") as dt:
            dt.datetime.now.return_value.timestamp.return_value = 100.0
            m._expire_dedicated_lpr()

        self.assertEqual(sorted(m.detected_license_plates), ["fresh", "unseen"])
        self.assertEqual(
            m.event_metadata_publisher.publish.call_args_list,
            [
                call(("orphan", 100.0), EventMetadataTypeEnum.manual_event_end.value),
                call(("stale", 100.0), EventMetadataTypeEnum.manual_event_end.value),
            ],
        )


class TestRecordingsAndReviewUpdates(MaintainerMixin):
    def test_saved_recordings_update_availability(self) -> None:
        m = self.build()
        m.recordings_subscriber.check_for_update.side_effect = [
            ("recordings/saved", (CAMERA, "main", 123.0, None)),
            ("recordings/latest", ("back", "main", 99.0, None)),
            ("recordings/saved", None),
            ("recordings/saved", ("never", "main", 1.0, None)),
        ]

        m._process_recordings_updates()

        self.assertEqual(m.recordings_available_through, {CAMERA: 123.0})
        self.assertEqual(m.recordings_subscriber.check_for_update.call_count, 3)

    def test_empty_recordings_update_stops(self) -> None:
        m = self.build()
        m.recordings_subscriber.check_for_update.return_value = None

        m._process_recordings_updates()

        self.assertEqual(m.recordings_available_through, {})

    def test_review_updates_go_to_review_processor(self) -> None:
        m = self.build()
        review = MagicMock(spec=ReviewDescriptionProcessor)
        other = MagicMock(spec=SemanticTriggerProcessor)
        m.post_processors = [review, other]
        m.review_subscriber.check_for_update.side_effect = [{"id": "r1"}, None]

        m._process_review_updates()

        review.process_data.assert_called_once_with(
            {"id": "r1"}, PostProcessDataEnum.review
        )
        other.process_data.assert_not_called()


class TestPublishRuntimeDevices(MaintainerMixin):
    def test_only_changed_devices_are_published(self) -> None:
        m = self.build()
        m.metrics.runtime_devices = MagicMock()

        with (
            patch.object(maintainer_module, "snapshot_loaded_devices") as snapshot,
            patch.object(maintainer_module, "fold_runtime_devices") as fold,
        ):
            fold.side_effect = [
                {"face_recognition": "CPU"},
                {"face_recognition": "CPU", "lpr": "GPU"},
                {"face_recognition": "CUDA", "lpr": "GPU"},
            ]
            m._publish_runtime_devices()
            m._publish_runtime_devices()
            m._publish_runtime_devices()

        fold.assert_called_with(snapshot.return_value)
        self.assertEqual(
            m.metrics.runtime_devices.__setitem__.call_args_list,
            [
                call("face_recognition", "CPU"),
                call("lpr", "GPU"),
                call("face_recognition", "CUDA"),
            ],
        )
        self.assertEqual(
            m._published_devices, {"face_recognition": "CUDA", "lpr": "GPU"}
        )


class TestProcessEventMetadata(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()
        self.describer = MagicMock(spec=ObjectDescriptionProcessor)
        self.other = MagicMock(spec=SemanticTriggerProcessor)
        self.m.post_processors = [self.describer, self.other]

    def test_no_update(self) -> None:
        self.m.event_metadata_subscriber.check_for_update.return_value = (None, None)

        self.m._process_event_metadata()

        self.describer.handle_request.assert_not_called()

    def test_regenerate_request_is_forwarded(self) -> None:
        self.m.event_metadata_subscriber.check_for_update.return_value = (
            "regenerate_description",
            ("ev1", "snapshot", True),
        )

        self.m._process_event_metadata()

        self.describer.handle_request.assert_called_once_with(
            "regenerate_description",
            {
                "event_id": "ev1",
                "source": RegenerateDescriptionEnum.snapshot,
                "force": True,
            },
        )
        self.other.handle_request.assert_not_called()

    def test_empty_event_id_is_ignored(self) -> None:
        self.m.event_metadata_subscriber.check_for_update.return_value = (
            "regenerate_description",
            ("", "thumbnails", False),
        )

        self.m._process_event_metadata()

        self.describer.handle_request.assert_not_called()


class TestProcessFrameUpdates(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        cameras = {
            CAMERA: make_camera(),
            "plates": make_camera("plates", type=CameraTypeEnum.lpr, track=("car",)),
            "tracked": make_camera(
                "tracked", type=CameraTypeEnum.lpr, track=("license_plate",)
            ),
        }
        self.m = self.build(make_config(cameras=cameras))
        self.frame = np.zeros(FRAME_SHAPE, np.uint8)
        self.m.frame_manager.get.return_value = self.frame
        self.lpr = MagicMock(spec=LicensePlateRealTimeProcessor)
        self.state = MagicMock(spec=CustomStateClassificationProcessor)
        self.face = MagicMock(spec=FaceRealTimeProcessor)
        self.m.realtime_processors = [self.lpr, self.state, self.face]

    def detection(self, camera: str, motion: list[Any]) -> None:
        self.m.detection_subscriber.check_for_update.return_value = (
            "video",
            (camera, "frame1", 1.0, [], motion, []),
        )
        self.m._process_frame_updates()

    def test_no_update(self) -> None:
        self.m.detection_subscriber.check_for_update.return_value = (None, None)

        self.m._process_frame_updates()

        self.m.frame_manager.get.assert_not_called()

    def test_unknown_camera_is_ignored(self) -> None:
        self.detection("gone", [[0, 0, 1, 1]])
        self.detection("", [[0, 0, 1, 1]])

        self.m.frame_manager.get.assert_not_called()

    def test_camera_without_frame_consumers_is_ignored(self) -> None:
        self.detection(CAMERA, [[0, 0, 1, 1]])
        # an lpr camera that also tracks plates is handled by the object path
        self.detection("tracked", [[0, 0, 1, 1]])

        self.m.frame_manager.get.assert_not_called()

    def test_dedicated_lpr_camera_with_motion(self) -> None:
        motion = [[0, 0, 10, 10]]

        self.detection("plates", motion)

        self.m.frame_manager.get.assert_called_once_with("frame1", FRAME_SHAPE)
        self.lpr.process_frame.assert_called_once_with("plates", self.frame, True)
        self.state.process_frame.assert_called_once_with(
            {"camera": "plates", "motion": motion}, self.frame
        )
        self.face.process_frame.assert_not_called()
        self.m.frame_manager.close.assert_called_once_with("frame1")

    def test_custom_state_model_without_motion(self) -> None:
        self.m.config.classification.custom = {"door": make_model("door")}

        self.detection(CAMERA, [])

        self.lpr.process_frame.assert_not_called()
        self.state.process_frame.assert_called_once_with(
            {"camera": CAMERA, "motion": []}, self.frame
        )

    def test_missing_frame_is_skipped(self) -> None:
        self.m.frame_manager.get.return_value = None

        self.detection("plates", [[0, 0, 1, 1]])

        self.lpr.process_frame.assert_not_called()
        self.m.frame_manager.close.assert_not_called()

    def test_frame_not_found_error(self) -> None:
        self.m.frame_manager.get.side_effect = FileNotFoundError

        # Upstream bug: same unassigned yuv_frame as _process_updates, so a
        # FileNotFoundError from frame_manager.get surfaces as UnboundLocalError
        with self.assertRaises(UnboundLocalError):
            self.detection("plates", [[0, 0, 1, 1]])


class TestProcessDeferredResults(MaintainerMixin):
    def setUp(self) -> None:
        super().setUp()
        self.m = self.build()
        self.processor = MagicMock()
        self.m.realtime_processors = [self.processor]

    def object_result(self, classification_type: Any) -> dict[str, Any]:
        return {
            "type": "classification",
            "processor": "object",
            "object_id": "ev1",
            "camera": CAMERA,
            "timestamp": 10.0,
            "model_name": "dog",
            "label": "husky",
            "score": 0.9,
            "classification_type": classification_type,
        }

    def test_state_result_is_sent(self) -> None:
        self.processor.drain_results.return_value = [
            {"type": "other"},
            {
                "type": "classification",
                "processor": "state",
                "camera": CAMERA,
                "model_name": "door",
                "state": "open",
            },
        ]

        self.m._process_deferred_results()

        self.m.requestor.send_data.assert_called_once_with(
            f"{CAMERA}/classification/door", "open"
        )
        self.m.event_metadata_publisher.publish.assert_not_called()

    def test_sub_label_result_is_published(self) -> None:
        self.processor.drain_results.return_value = [
            self.object_result(ObjectClassificationType.sub_label)
        ]

        self.m._process_deferred_results()

        self.m.event_metadata_publisher.publish.assert_called_once_with(
            ("ev1", "husky", 0.9), EventMetadataTypeEnum.sub_label
        )
        topic, payload = self.m.requestor.send_data.call_args.args
        self.assertEqual(topic, "tracked_object_update")
        self.assertEqual(
            json.loads(payload),
            {
                "type": TrackedObjectUpdateTypesEnum.classification.value,
                "id": "ev1",
                "camera": CAMERA,
                "timestamp": 10.0,
                "model": "dog",
                "sub_label": "husky",
                "score": 0.9,
            },
        )

    def test_attribute_result_is_published(self) -> None:
        self.processor.drain_results.return_value = [
            self.object_result(ObjectClassificationType.attribute)
        ]

        self.m._process_deferred_results()

        self.m.event_metadata_publisher.publish.assert_called_once_with(
            ("ev1", "dog", "husky", 0.9), EventMetadataTypeEnum.attribute.value
        )
        payload = json.loads(self.m.requestor.send_data.call_args.args[1])
        self.assertEqual(payload["attribute"], "husky")
        self.assertNotIn("sub_label", payload)

    def test_unknown_classification_type_is_ignored(self) -> None:
        self.processor.drain_results.return_value = [self.object_result("other")]

        self.m._process_deferred_results()

        self.m.event_metadata_publisher.publish.assert_not_called()
        self.m.requestor.send_data.assert_not_called()


if __name__ == "__main__":
    unittest.main()
