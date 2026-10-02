"""Coverage for the SQLite-vec embeddings wrapper (fork D73).

Exercises Embeddings with mocked ONNX/Jina and GenAI models, a MagicMock
vector database for the vec0 statements, and an in-memory SQLite database
bound to the Event and Trigger models for reindexing and trigger sync.
"""

import base64
import io
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np
from peewee import IntegrityError
from PIL import Image
from playhouse.sqlite_ext import SqliteExtDatabase

# Mock TFLite before importing the embeddings package
for _mod in (
    "tflite_runtime",
    "tflite_runtime.interpreter",
    "ai_edge_litert",
    "ai_edge_litert.interpreter",
):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# the maintainer is imported first to avoid the circular import between the
# embeddings package and the processor modules
import frigate.embeddings.maintainer  # noqa: E402, F401
from frigate.config.classification import SemanticSearchModelEnum  # noqa: E402
from frigate.const import (  # noqa: E402
    UPDATE_EMBEDDINGS_REINDEX_PROGRESS,
    UPDATE_MODEL_STATE,
)
from frigate.embeddings import embeddings as embeddings_module  # noqa: E402
from frigate.embeddings.embeddings import Embeddings, get_metadata  # noqa: E402
from frigate.models import Event, Trigger  # noqa: E402
from frigate.types import ModelStatusTypesEnum  # noqa: E402
from frigate.util.builtin import serialize  # noqa: E402

CAMERA = "front"

TRIGGER_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS trigger (
    camera VARCHAR(20) NOT NULL,
    name VARCHAR NOT NULL,
    type VARCHAR(10) NOT NULL,
    model VARCHAR(30) NOT NULL,
    data TEXT NOT NULL,
    threshold REAL,
    embedding BLOB,
    triggering_event_id VARCHAR(30),
    last_triggered DATETIME,
    PRIMARY KEY (camera, name)
)
"""


def jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="JPEG")
    return buf.getvalue()


def make_config(
    model: Any = SemanticSearchModelEnum.jinav1,
    model_size: str = "small",
    device: str | None = None,
    cameras: dict[str, Any] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        semantic_search=SimpleNamespace(
            model=model, model_size=model_size, device=device
        ),
        cameras=cameras or {},
    )


def make_metrics() -> SimpleNamespace:
    return SimpleNamespace(
        image_embeddings_speed=SimpleNamespace(value=0.0),
        image_embeddings_eps=SimpleNamespace(value=0.0),
        text_embeddings_speed=SimpleNamespace(value=0.0),
        text_embeddings_eps=SimpleNamespace(value=0.0),
    )


def make_camera(triggers: dict[str, Any] | None) -> SimpleNamespace:
    return SimpleNamespace(
        name=CAMERA, semantic_search=SimpleNamespace(triggers=triggers)
    )


def trigger_cfg(type: str, data: str, threshold: float = 0.8) -> SimpleNamespace:
    return SimpleNamespace(type=type, data=data, threshold=threshold)


class ModelPatchMixin(unittest.TestCase):
    """Patch every model and IPC class the Embeddings constructor touches."""

    def setUp(self) -> None:
        self.requestor_cls = self._patch("InterProcessRequestor")
        self.requestor = self.requestor_cls.return_value
        self.text_cls = self._patch("JinaV1TextEmbedding")
        self.image_cls = self._patch("JinaV1ImageEmbedding")
        self.v2_cls = self._patch("JinaV2Embedding")
        self.genai_cls = self._patch("GenAIEmbedding")
        self.db = MagicMock()
        self.metrics = make_metrics()

    def _patch(self, name: str) -> MagicMock:
        patcher = patch.object(embeddings_module, name)
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def make(self, config: SimpleNamespace | None = None, **kwargs: Any) -> Embeddings:
        return Embeddings(config or make_config(), self.db, self.metrics, **kwargs)


class TestEmbeddingsInit(ModelPatchMixin):
    def test_jinav1_small_uses_cpu_and_publishes_model_states(self) -> None:
        emb = self.make()

        self.db.create_embeddings_tables.assert_called_once_with()
        self.text_cls.assert_called_once_with(
            model_size="small", requestor=self.requestor, device="CPU"
        )
        self.image_cls.assert_called_once_with(
            model_size="small", requestor=self.requestor, device="CPU"
        )
        self.assertIs(emb.text_embedding, self.text_cls.return_value)
        self.assertIs(emb.vision_embedding, self.image_cls.return_value)
        self.v2_cls.assert_not_called()

        published = [
            c.args[1]["model"] for c in self.requestor.send_data.call_args_list
        ]
        self.assertEqual(
            published,
            [
                "jinaai/jina-clip-v1-text_model_fp16.onnx",
                "jinaai/jina-clip-v1-tokenizer",
                "jinaai/jina-clip-v1-vision_model_quantized.onnx",
                "jinaai/jina-clip-v1-preprocessor_config.json",
                "facenet-facenet.onnx",
                "paddleocr-onnx-detection.onnx",
                "paddleocr-onnx-classification.onnx",
                "paddleocr-onnx-recognition.onnx",
            ],
        )
        for c in self.requestor.send_data.call_args_list:
            self.assertEqual(c.args[0], UPDATE_MODEL_STATE)
            self.assertEqual(c.args[1]["state"], ModelStatusTypesEnum.not_downloaded)

    def test_jinav1_large_defaults_vision_to_gpu(self) -> None:
        emb = self.make(make_config(model_size="large"))

        self.assertEqual(self.image_cls.call_args.kwargs["device"], "GPU")
        self.assertEqual(self.text_cls.call_args.kwargs["device"], "CPU")
        self.assertIn(
            "jinaai/jina-clip-v1-vision_model_fp16.onnx",
            emb.get_model_definitions(),
        )

    def test_jinav1_explicit_device_wins(self) -> None:
        self.make(make_config(model_size="large", device="NPU"))

        self.assertEqual(self.image_cls.call_args.kwargs["device"], "NPU")

    def test_jinav2_routes_text_and_vision_through_one_model(self) -> None:
        emb = self.make(make_config(model=SemanticSearchModelEnum.jinav2))

        self.v2_cls.assert_called_once_with(
            model_size="small", requestor=self.requestor, device="CPU"
        )
        self.text_cls.assert_not_called()
        model = self.v2_cls.return_value

        emb.text_embedding(["a dog"])
        model.assert_called_with(["a dog"], embedding_type="text")
        emb.vision_embedding([b"img"])
        model.assert_called_with([b"img"], embedding_type="vision")

        self.assertEqual(
            emb.get_model_definitions()[:3],
            [
                "jinaai/jina-clip-v2-tokenizer",
                "jinaai/jina-clip-v2-model_quantized.onnx",
                "jinaai/jina-clip-v2-preprocessor_config.json",
            ],
        )

    def test_jinav2_large_uses_fp16_model_on_gpu(self) -> None:
        emb = self.make(
            make_config(model=SemanticSearchModelEnum.jinav2, model_size="large")
        )

        self.assertEqual(self.v2_cls.call_args.kwargs["device"], "GPU")
        self.assertIn(
            "jinaai/jina-clip-v2-model_fp16.onnx", emb.get_model_definitions()
        )

    def test_genai_provider_without_manager_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "no embeddings client"):
            self.make(make_config(model="my_provider"))

    def test_genai_provider_without_embeddings_client_raises(self) -> None:
        manager = SimpleNamespace(embeddings_client=None)

        with self.assertRaises(ValueError):
            self.make(make_config(model="my_provider"), genai_manager=manager)

    def test_genai_provider_wraps_client(self) -> None:
        client = MagicMock()
        manager = SimpleNamespace(embeddings_client=client)

        emb = self.make(make_config(model="my_provider"), genai_manager=manager)

        self.genai_cls.assert_called_once_with(client)
        model = self.genai_cls.return_value
        emb.text_embedding(["x"])
        model.assert_called_with(["x"], embedding_type="text")
        emb.vision_embedding([b"y"])
        model.assert_called_with([b"y"], embedding_type="vision")
        # only the shared enrichment models remain to be announced
        self.assertEqual(
            emb.get_model_definitions(),
            [
                "facenet-facenet.onnx",
                "paddleocr-onnx-detection.onnx",
                "paddleocr-onnx-classification.onnx",
                "paddleocr-onnx-recognition.onnx",
            ],
        )

    def test_update_stats_copies_eps_into_metrics(self) -> None:
        emb = self.make()
        emb.image_eps = MagicMock()
        emb.image_eps.eps.return_value = 2.5
        emb.text_eps = MagicMock()
        emb.text_eps.eps.return_value = 1.5

        emb.update_stats()

        self.assertEqual(self.metrics.image_embeddings_eps.value, 2.5)
        self.assertEqual(self.metrics.text_embeddings_eps.value, 1.5)


class TestEmbedCalls(ModelPatchMixin):
    def setUp(self) -> None:
        super().setUp()
        self.emb = self.make()
        self.vector = np.array([0.5, 0.25], dtype=np.float32)

    def test_embed_thumbnail_upserts(self) -> None:
        self.emb.vision_embedding = MagicMock(return_value=[self.vector])

        result = self.emb.embed_thumbnail("ev1", b"thumb")

        self.emb.vision_embedding.assert_called_once_with([b"thumb"])
        np.testing.assert_array_equal(result, self.vector)
        sql, params = self.db.execute_sql.call_args.args
        self.assertIn("vec_thumbnails", sql)
        self.assertEqual(params, ("ev1", serialize(self.vector)))
        self.assertEqual(len(self.emb.image_eps._timestamps), 1)

    def test_embed_thumbnail_without_upsert_skips_db(self) -> None:
        self.emb.vision_embedding = MagicMock(return_value=[self.vector])

        self.emb.embed_thumbnail("ev1", b"thumb", upsert=False)

        self.db.execute_sql.assert_not_called()

    def test_batch_embed_thumbnail_skips_corrupt_images(self) -> None:
        good = jpeg_bytes()
        self.emb.vision_embedding = MagicMock(return_value=[self.vector])

        result = self.emb.batch_embed_thumbnail({"bad": b"not an image", "ok": good})

        self.emb.vision_embedding.assert_called_once_with([good])
        self.assertEqual(len(result), 1)
        sql, items = self.db.execute_sql.call_args.args
        self.assertEqual(sql.count("(?, ?)"), 1)
        self.assertEqual(items, ["ok", serialize(self.vector)])

    def test_batch_embed_thumbnail_all_corrupt_returns_empty(self) -> None:
        self.emb.vision_embedding = MagicMock()

        self.assertEqual(self.emb.batch_embed_thumbnail({"bad": b"nope"}), [])
        self.emb.vision_embedding.assert_not_called()
        self.db.execute_sql.assert_not_called()

    def test_batch_embed_thumbnail_without_upsert(self) -> None:
        self.emb.vision_embedding = MagicMock(return_value=[self.vector])

        self.emb.batch_embed_thumbnail({"ok": jpeg_bytes()}, upsert=False)

        self.db.execute_sql.assert_not_called()

    def test_embed_description_upserts(self) -> None:
        self.emb.text_embedding = MagicMock(return_value=[self.vector])

        result = self.emb.embed_description("ev1", "a red car")

        self.emb.text_embedding.assert_called_once_with(["a red car"])
        np.testing.assert_array_equal(result, self.vector)
        sql, params = self.db.execute_sql.call_args.args
        self.assertIn("vec_descriptions", sql)
        self.assertEqual(params, ("ev1", serialize(self.vector)))

    def test_embed_description_without_upsert(self) -> None:
        self.emb.text_embedding = MagicMock(return_value=[self.vector])

        self.emb.embed_description("", "query", upsert=False)

        self.db.execute_sql.assert_not_called()

    def test_batch_embed_description_embeds_one_by_one(self) -> None:
        other = np.array([1.0, 0.0], dtype=np.float32)
        self.emb.text_embedding = MagicMock(side_effect=[[self.vector], [other]])

        result = self.emb.batch_embed_description({"a": "one", "b": "two"})

        self.assertEqual(self.emb.text_embedding.call_count, 2)
        self.assertEqual(len(result), 2)
        sql, items = self.db.execute_sql.call_args.args
        self.assertEqual(sql.count("(?, ?)"), 2)
        self.assertEqual(items, ["a", serialize(self.vector), "b", serialize(other)])

    def test_batch_embed_description_without_upsert(self) -> None:
        self.emb.text_embedding = MagicMock(return_value=[self.vector])

        self.emb.batch_embed_description({"a": "one"}, upsert=False)

        self.db.execute_sql.assert_not_called()


class DatabaseMixin(ModelPatchMixin):
    """Bind Event and Trigger to an in-memory database and redirect dirs."""

    def setUp(self) -> None:
        super().setUp()
        self.sqlite = SqliteExtDatabase(":memory:")
        self.enterContext(self.sqlite.bind_ctx([Event, Trigger]))
        self.sqlite.connect()
        self.addCleanup(self.sqlite.close)
        self.sqlite.create_tables([Event])
        self.sqlite.execute_sql(TRIGGER_TABLE_SQL)

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.trigger_dir = os.path.join(self.tmp, "triggers")
        self.config_dir = os.path.join(self.tmp, "config")
        self.thumb_dir = os.path.join(self.tmp, "thumbs")
        os.makedirs(self.config_dir)
        self.enterContext(
            patch.object(embeddings_module, "TRIGGER_DIR", self.trigger_dir)
        )
        self.enterContext(
            patch.object(embeddings_module, "CONFIG_DIR", self.config_dir)
        )
        self.enterContext(patch("frigate.util.file.THUMB_DIR", self.thumb_dir))

    def add_event(
        self,
        event_id: str,
        start: float,
        thumbnail: bytes | None = None,
        data: dict[str, Any] | None = None,
        zones: list[str] | None = None,
    ) -> Event:
        return Event.create(
            id=event_id,
            label="person",
            sub_label=None,
            camera=CAMERA,
            start_time=start,
            end_time=start + 5,
            top_score=0.9,
            score=0.9,
            false_positive=False,
            zones=zones or [],
            thumbnail=base64.b64encode(thumbnail).decode() if thumbnail else "",
            has_clip=True,
            has_snapshot=True,
            region=[0, 0, 1, 1],
            box=[0, 0, 1, 1],
            area=1,
            retain_indefinitely=False,
            ratio=1.0,
            plus_id="",
            model_hash="",
            detector_type="",
            model_type="",
            data=data if data is not None else {"type": "object"},
        )


class TestGetMetadata(DatabaseMixin):
    def test_flattens_event_data_and_zones(self) -> None:
        event = self.add_event(
            "ev1",
            10.0,
            thumbnail=b"x",
            data={"type": "object", "description": "secret", "score": 0.7, "box": [1]},
            zones=["porch", "yard"],
        )

        meta = get_metadata(Event.get(Event.id == event.id))

        self.assertEqual(meta["id"], "ev1")
        self.assertEqual(meta["camera"], CAMERA)
        self.assertEqual(meta["type"], "object")
        self.assertEqual(meta["score"], 0.7)
        self.assertNotIn("thumbnail", meta)
        self.assertNotIn("description", meta)
        self.assertNotIn("box", meta)
        self.assertNotIn("sub_label", meta)
        self.assertTrue(meta["zones_porch"])
        self.assertTrue(meta["zones_yard"])


class TestReindex(DatabaseMixin):
    def setUp(self) -> None:
        super().setUp()
        time_patcher = patch.object(embeddings_module, "time")
        self.time = time_patcher.start()
        self.addCleanup(time_patcher.stop)
        self.time.time.return_value = 100.0
        # reindex mutates one totals dict, so snapshot it on every send
        self.sent: list[tuple[str, Any]] = []
        self.requestor.send_data.side_effect = lambda topic, payload: self.sent.append(
            (topic, dict(payload))
        )

    def progress(self) -> list[dict[str, Any]]:
        return [p for t, p in self.sent if t == UPDATE_EMBEDDINGS_REINDEX_PROGRESS]

    def test_reindex_small_batch_embeds_thumbnails_and_descriptions(self) -> None:
        stats = os.path.join(self.config_dir, ".search_stats.json")
        with open(stats, "w") as f:
            f.write("{}")
        self.add_event("a", 1.0, thumbnail=b"t", data={"description": " a dog "})
        self.add_event("b", 2.0, data={"description": ""})
        self.add_event("c", 3.0, thumbnail=b"u", data={})
        emb = self.make()
        emb.batch_embed_thumbnail = MagicMock()
        emb.batch_embed_description = MagicMock()

        emb.reindex()

        self.db.drop_embeddings_tables.assert_called_once_with()
        self.assertEqual(self.db.create_embeddings_tables.call_count, 2)
        self.assertFalse(os.path.exists(stats))
        emb.batch_embed_thumbnail.assert_called_once_with({"c": b"u", "a": b"t"})
        emb.batch_embed_description.assert_called_once_with({"a": "a dog"})

        updates = self.progress()
        self.assertEqual(updates[-1]["status"], "completed")
        self.assertEqual(updates[-1]["thumbnails"], 2)
        self.assertEqual(updates[-1]["descriptions"], 1)
        self.assertEqual(updates[-1]["total_objects"], 3)
        # Upstream bug: when there are fewer events than one batch the counter
        # is seeded with total_events - 1 and then incremented once per event,
        # so processed_objects ends at 2 * total - 1 (5 of 3 here) and the
        # reported progress exceeds 100 percent. Seeding it with 0 (or not
        # incrementing in that case) would fix it.
        self.assertEqual(updates[0]["processed_objects"], 2)
        self.assertEqual(updates[-1]["processed_objects"], 5)

    def test_reindex_genai_pages_one_event_at_a_time(self) -> None:
        self.add_event("a", 1.0, thumbnail=b"t", data={"description": "x"})
        self.add_event("b", 2.0, data={})
        manager = SimpleNamespace(embeddings_client=MagicMock())
        emb = self.make(make_config(model="provider"), genai_manager=manager)
        emb.batch_embed_thumbnail = MagicMock()
        emb.batch_embed_description = MagicMock()
        self.time.time.side_effect = [100.0, 104.0, 106.0, 108.0]

        emb.reindex()

        # newest first, one event per page
        emb.batch_embed_thumbnail.assert_called_once_with({"a": b"t"})
        emb.batch_embed_description.assert_called_once_with({"a": "x"})
        updates = self.progress()
        self.assertEqual([u["processed_objects"] for u in updates], [0, 1, 2, 2])
        # 4 seconds for the first of two events leaves one event at 4 s
        self.assertEqual(updates[1]["time_remaining"], 4)
        self.assertEqual(updates[2]["time_remaining"], 0)
        self.assertEqual(updates[0]["time_remaining"], -1)

    def test_reindex_jinav2_with_no_events(self) -> None:
        emb = self.make(make_config(model=SemanticSearchModelEnum.jinav2))

        emb.reindex()

        updates = self.progress()
        self.assertEqual(len(updates), 2)
        self.assertEqual(updates[0]["total_objects"], 0)
        self.assertEqual(updates[0]["time_remaining"], 0)
        self.assertEqual(updates[-1]["status"], "completed")


class TestStartReindex(ModelPatchMixin):
    def test_start_reindex_spawns_thread_once(self) -> None:
        emb = self.make()

        with patch.object(embeddings_module.threading, "Thread") as thread_cls:
            self.assertTrue(emb.start_reindex())
            self.assertFalse(emb.start_reindex())

        thread_cls.assert_called_once_with(target=emb._reindex_wrapper, daemon=True)
        thread_cls.return_value.start.assert_called_once_with()
        self.assertTrue(emb.reindex_running)

    def test_reindex_wrapper_resets_flag_on_success(self) -> None:
        emb = self.make()
        emb.reindex = MagicMock()
        emb.reindex_running = True
        emb.reindex_thread = object()

        emb._reindex_wrapper()

        emb.reindex.assert_called_once_with()
        self.assertFalse(emb.reindex_running)
        self.assertIsNone(emb.reindex_thread)

    def test_reindex_wrapper_resets_flag_on_failure(self) -> None:
        emb = self.make()
        emb.reindex = MagicMock(side_effect=RuntimeError("boom"))
        emb.reindex_running = True

        with self.assertRaises(RuntimeError):
            emb._reindex_wrapper()

        self.assertFalse(emb.reindex_running)


class TestTriggerHelpers(DatabaseMixin):
    def setUp(self) -> None:
        super().setUp()
        self.emb = self.make()
        self.vector = np.array([1.0, 2.0], dtype=np.float32)

    def test_write_and_remove_trigger_thumbnail(self) -> None:
        self.emb.write_trigger_thumbnail(CAMERA, "ev1", b"img")
        path = os.path.join(self.trigger_dir, CAMERA, "ev1.webp")
        with open(path, "rb") as f:
            self.assertEqual(f.read(), b"img")

        self.emb.remove_trigger_thumbnail(CAMERA, "ev1")
        self.assertFalse(os.path.exists(path))

    def test_write_trigger_thumbnail_logs_failure(self) -> None:
        with (
            patch.object(embeddings_module.os, "makedirs", side_effect=OSError("ro")),
            self.assertLogs(embeddings_module.logger, "ERROR") as logs,
        ):
            self.emb.write_trigger_thumbnail(CAMERA, "ev1", b"img")

        self.assertIn("Failed to write thumbnail", logs.output[0])

    def test_remove_missing_trigger_thumbnail_logs_failure(self) -> None:
        with self.assertLogs(embeddings_module.logger, "ERROR") as logs:
            self.emb.remove_trigger_thumbnail(CAMERA, "missing")

        self.assertIn("Failed to delete thumbnail", logs.output[0])

    def test_description_trigger_embedding(self) -> None:
        self.emb.text_embedding = MagicMock(return_value=[self.vector])

        result = self.emb._calculate_trigger_embedding(
            trigger_cfg("description", "a cat"), "t", CAMERA
        )

        self.assertEqual(result, self.vector.tobytes())
        self.db.execute_sql.assert_not_called()

    def test_thumbnail_trigger_uses_stored_embedding(self) -> None:
        self.db.execute_sql.return_value.fetchone.return_value = (b"stored",)

        result = self.emb._calculate_trigger_embedding(
            trigger_cfg("thumbnail", "ev1"), "t", CAMERA
        )

        self.assertEqual(result, b"stored")
        self.assertEqual(self.db.execute_sql.call_args.args[1], ["ev1"])

    def test_thumbnail_trigger_embeds_saved_file(self) -> None:
        self.db.execute_sql.return_value = None
        self.emb.write_trigger_thumbnail(CAMERA, "ev1", b"img")
        self.emb.vision_embedding = MagicMock(return_value=[self.vector])

        result = self.emb._calculate_trigger_embedding(
            trigger_cfg("thumbnail", "ev1"), "t", CAMERA
        )

        self.emb.vision_embedding.assert_called_once_with([b"img"])
        self.assertEqual(result, self.vector.tobytes())

    def test_thumbnail_trigger_missing_file_returns_empty(self) -> None:
        self.db.execute_sql.return_value.fetchone.return_value = None

        with self.assertLogs(embeddings_module.logger, "ERROR"):
            result = self.emb._calculate_trigger_embedding(
                trigger_cfg("thumbnail", "nope"), "t", CAMERA
            )

        self.assertEqual(result, b"")

    def test_unknown_trigger_type_returns_empty(self) -> None:
        with self.assertLogs(embeddings_module.logger, "WARNING"):
            result = self.emb._calculate_trigger_embedding(
                trigger_cfg("audio", "x"), "t", CAMERA
            )

        self.assertEqual(result, b"")


class TestSyncTriggers(DatabaseMixin):
    def setUp(self) -> None:
        super().setUp()
        self.vector = np.array([3.0, 4.0], dtype=np.float32)

    def sync(self, triggers: dict[str, Any] | None) -> Embeddings:
        emb = self.make(make_config(cameras={CAMERA: make_camera(triggers)}))
        emb.text_embedding = MagicMock(return_value=[self.vector])
        emb.vision_embedding = MagicMock(return_value=[self.vector])
        self.db.execute_sql.return_value.fetchone.return_value = None
        emb.sync_triggers()
        return emb

    def add_trigger(
        self,
        name: str,
        type: str,
        data: str,
        threshold: float = 0.8,
        embedding: bytes = b"old",
    ) -> None:
        Trigger.create(
            camera=CAMERA,
            name=name,
            type=type,
            data=data,
            threshold=threshold,
            model="jinav1",
            embedding=embedding,
            triggering_event_id="",
            last_triggered=None,
        )

    def triggers(self) -> dict[str, Trigger]:
        return {t.name: t for t in Trigger.select()}

    def test_creates_description_trigger(self) -> None:
        self.sync({"dog": trigger_cfg("description", "a dog", 0.6)})

        trigger = self.triggers()["dog"]
        self.assertEqual(trigger.type, "description")
        self.assertEqual(trigger.threshold, 0.6)
        self.assertEqual(bytes(trigger.embedding), self.vector.tobytes())

    def test_creates_thumbnail_trigger_and_writes_file(self) -> None:
        self.add_event("ev1", 1.0, thumbnail=b"img")

        self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        trigger = self.triggers()["snap"]
        self.assertEqual(bytes(trigger.embedding), self.vector.tobytes())
        with open(os.path.join(self.trigger_dir, CAMERA, "ev1.webp"), "rb") as f:
            self.assertEqual(f.read(), b"img")

    def test_new_thumbnail_trigger_skipped_for_missing_event(self) -> None:
        with self.assertLogs(embeddings_module.logger, "WARNING"):
            self.sync({"snap": trigger_cfg("thumbnail", "nope")})

        self.assertEqual(self.triggers(), {})

    def test_new_thumbnail_trigger_skipped_for_non_object(self) -> None:
        self.add_event("ev1", 1.0, thumbnail=b"img", data={"type": "audio"})

        with self.assertLogs(embeddings_module.logger, "WARNING"):
            self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        self.assertEqual(self.triggers(), {})

    def test_new_thumbnail_trigger_skipped_without_thumbnail(self) -> None:
        self.add_event("ev1", 1.0)

        with self.assertLogs(embeddings_module.logger, "WARNING") as logs:
            self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        self.assertIn("Unable to retrieve thumbnail", logs.output[0])
        self.assertEqual(self.triggers(), {})

    def test_duplicate_create_is_ignored(self) -> None:
        with patch.object(
            embeddings_module.Trigger, "create", side_effect=IntegrityError("dup")
        ) as create:
            self.sync({"dog": trigger_cfg("description", "a dog")})

        create.assert_called_once()

    def test_unchanged_trigger_is_not_saved(self) -> None:
        self.add_trigger("dog", "description", "a dog", 0.8, embedding=b"keep")

        emb = self.sync({"dog": trigger_cfg("description", "a dog", 0.8)})

        emb.text_embedding.assert_not_called()
        self.assertEqual(bytes(self.triggers()["dog"].embedding), b"keep")

    def test_changed_trigger_is_reembedded(self) -> None:
        self.add_trigger("dog", "description", "a dog", 0.8)

        self.sync({"dog": trigger_cfg("description", "a big dog", 0.5)})

        trigger = self.triggers()["dog"]
        self.assertEqual(trigger.data, "a big dog")
        self.assertEqual(trigger.threshold, 0.5)
        self.assertEqual(bytes(trigger.embedding), self.vector.tobytes())

    def test_missing_embedding_is_regenerated(self) -> None:
        self.add_trigger("dog", "description", "a dog", 0.8, embedding=b"")

        self.sync({"dog": trigger_cfg("description", "a dog", 0.8)})

        self.assertEqual(bytes(self.triggers()["dog"].embedding), self.vector.tobytes())

    def test_existing_thumbnail_trigger_rewrites_missing_file(self) -> None:
        self.add_event("ev1", 1.0, thumbnail=b"img")
        self.add_trigger("snap", "thumbnail", "ev1", embedding=b"old")

        self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        self.assertTrue(
            os.path.exists(os.path.join(self.trigger_dir, CAMERA, "ev1.webp"))
        )
        self.assertEqual(
            bytes(self.triggers()["snap"].embedding), self.vector.tobytes()
        )

    def test_existing_thumbnail_trigger_with_file_keeps_embedding(self) -> None:
        self.add_event("ev1", 1.0, thumbnail=b"img")
        self.add_trigger("snap", "thumbnail", "ev1", embedding=b"old")
        os.makedirs(os.path.join(self.trigger_dir, CAMERA))
        with open(os.path.join(self.trigger_dir, CAMERA, "ev1.webp"), "wb") as f:
            f.write(b"img")

        self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        self.assertEqual(bytes(self.triggers()["snap"].embedding), b"old")

    def test_existing_thumbnail_trigger_skips_missing_event(self) -> None:
        self.add_trigger("snap", "thumbnail", "gone", embedding=b"old")

        self.sync({"snap": trigger_cfg("thumbnail", "gone")})

        self.assertEqual(bytes(self.triggers()["snap"].embedding), b"old")

    def test_existing_thumbnail_trigger_skips_non_object(self) -> None:
        self.add_event("ev1", 1.0, thumbnail=b"img", data={"type": "audio"})
        self.add_trigger("snap", "thumbnail", "ev1", embedding=b"old")

        with self.assertLogs(embeddings_module.logger, "WARNING"):
            self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        self.assertEqual(bytes(self.triggers()["snap"].embedding), b"old")

    def test_existing_thumbnail_trigger_skips_without_thumbnail(self) -> None:
        self.add_event("ev1", 1.0)
        self.add_trigger("snap", "thumbnail", "ev1", embedding=b"old")

        with self.assertLogs(embeddings_module.logger, "WARNING"):
            self.sync({"snap": trigger_cfg("thumbnail", "ev1")})

        self.assertEqual(bytes(self.triggers()["snap"].embedding), b"old")

    def test_removed_triggers_are_deleted_with_their_files(self) -> None:
        self.add_trigger("snap", "thumbnail", "ev1")
        self.add_trigger("dog", "description", "a dog")
        os.makedirs(os.path.join(self.trigger_dir, CAMERA))
        path = os.path.join(self.trigger_dir, CAMERA, "ev1.webp")
        with open(path, "wb") as f:
            f.write(b"img")

        self.sync(None)

        self.assertEqual(self.triggers(), {})
        self.assertFalse(os.path.exists(path))


if __name__ == "__main__":
    unittest.main()
