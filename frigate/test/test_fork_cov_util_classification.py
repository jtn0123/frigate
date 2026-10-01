"""Coverage for the dataset and training helpers in frigate.util.classification (fork D70)."""

import os
import shutil
import sys
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import cv2
import numpy as np
from peewee import SqliteDatabase

from frigate.comms.embeddings_updater import EmbeddingsRequestEnum
from frigate.const import UPDATE_MODEL_STATE
from frigate.models import Recordings, ReviewSegment
from frigate.types import ModelStatusTypesEnum
from frigate.util import classification as cls
from frigate.util.classification import (
    TRAINING_METADATA_FILE,
    ClassificationTrainingProcess,
    _extract_event_thumbnails,
    _extract_keyframes,
    _load_event_classification_crop,
    _select_balanced_events,
    _select_balanced_timestamps,
    _select_distinct_images,
    collect_object_classification_examples,
    collect_state_classification_examples,
    get_dataset_image_count,
    kickoff_model_training,
    read_training_metadata,
    write_training_metadata,
)

TRAIN_METHOD = "_ClassificationTrainingProcess__train_classification_model"
FACTORY_METHOD = (
    "_ClassificationTrainingProcess__generate_representative_dataset_factory"
)


def _solid(
    color: tuple[int, int, int], height: int = 20, width: int = 30
) -> np.ndarray:
    img = np.zeros((height, width, 3), np.uint8)
    img[:] = color
    return img


def _jpeg(img: np.ndarray) -> bytes:
    ok, data = cv2.imencode(".jpg", img)
    assert ok
    return data.tobytes()


class _TempDirsMixin:
    """Point CLIPS_DIR and MODEL_CACHE_DIR at a private temporary directory."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="fork_d70_cls_")
        self.clips = os.path.join(self.tmp, "clips")
        self.cache = os.path.join(self.tmp, "model_cache")
        os.makedirs(self.clips)
        os.makedirs(self.cache)
        for name, value in (("CLIPS_DIR", self.clips), ("MODEL_CACHE_DIR", self.cache)):
            patcher = patch.object(cls, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _write_image(self, path: str, img: np.ndarray) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        cv2.imwrite(path, img)
        return path


class TestTrainingMetadata(_TempDirsMixin, unittest.TestCase):
    def test_write_then_read_round_trip(self) -> None:
        write_training_metadata("  doorbell ", 42)
        path = os.path.join(self.clips, "doorbell", TRAINING_METADATA_FILE)
        self.assertTrue(os.path.exists(path))
        metadata = read_training_metadata("doorbell ")
        self.assertEqual(metadata["last_training_image_count"], 42)
        self.assertIn("T", metadata["last_training_date"])

    def test_read_missing_returns_none(self) -> None:
        self.assertIsNone(read_training_metadata("nothing"))

    def test_read_corrupt_returns_none(self) -> None:
        model_dir = os.path.join(self.clips, "broken")
        os.makedirs(model_dir)
        with open(os.path.join(model_dir, TRAINING_METADATA_FILE), "w") as f:
            f.write("{not json")
        with self.assertLogs(cls.logger, level="ERROR"):
            self.assertIsNone(read_training_metadata("broken"))

    def test_write_failure_is_logged(self) -> None:
        with (
            patch("builtins.open", side_effect=OSError("read only")),
            self.assertLogs(cls.logger, level="ERROR") as logs,
        ):
            write_training_metadata("model", 3)
        self.assertIn("Failed to write training metadata", logs.output[0])


class TestDatasetImageCount(_TempDirsMixin, unittest.TestCase):
    def test_missing_dataset_is_zero(self) -> None:
        self.assertEqual(get_dataset_image_count("missing"), 0)

    def test_counts_supported_images_in_category_dirs(self) -> None:
        dataset = os.path.join(self.clips, "gate", "dataset")
        for category, files in (
            ("open", ["a.webp", "b.PNG", "c.jpg", "notes.txt"]),
            ("closed", ["d.jpeg"]),
        ):
            os.makedirs(os.path.join(dataset, category))
            for name in files:
                open(os.path.join(dataset, category, name), "w").close()
        open(os.path.join(dataset, "stray.jpg"), "w").close()
        self.assertEqual(get_dataset_image_count(" gate "), 4)

    def test_listing_error_returns_zero(self) -> None:
        os.makedirs(os.path.join(self.clips, "gate", "dataset"))
        with (
            patch.object(cls.os, "listdir", side_effect=PermissionError("denied")),
            self.assertLogs(cls.logger, level="ERROR"),
        ):
            self.assertEqual(get_dataset_image_count("gate"), 0)


def _fake_tensorflow(convert_result: bytes = b"tflite-model"):
    tf = MagicMock(name="tensorflow")
    keras = MagicMock(name="tensorflow.keras")
    applications = MagicMock(name="tensorflow.keras.applications")
    preprocessing = MagicMock(name="tensorflow.keras.preprocessing")
    image_mod = MagicMock(name="tensorflow.keras.preprocessing.image")

    converter = tf.lite.TFLiteConverter.from_keras_model.return_value
    converter.convert.return_value = convert_result
    train_gen = image_mod.ImageDataGenerator.return_value.flow_from_directory
    train_gen.return_value.class_indices = {"dog": 0, "cat": 1}
    train_gen.return_value.samples = 4

    modules = {
        "tensorflow": tf,
        "tensorflow.keras": keras,
        "tensorflow.keras.applications": applications,
        "tensorflow.keras.preprocessing": preprocessing,
        "tensorflow.keras.preprocessing.image": image_mod,
    }
    return modules, tf, keras, applications, converter


class TestClassificationTrainingProcess(_TempDirsMixin, unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        env = patch.dict(os.environ, {"TF_KERAS_MOBILENET_V2_WEIGHTS_URL": ""})
        env.start()
        self.addCleanup(env.stop)

    def _dataset(self, name: str, classes: list[str]) -> str:
        dataset = os.path.join(self.clips, name, "dataset")
        os.makedirs(dataset, exist_ok=True)
        colors = [(0, 0, 255), (255, 0, 0), (0, 255, 0)]
        for idx, category in enumerate(classes):
            self._write_image(
                os.path.join(dataset, category, "one.jpg"), _solid(colors[idx % 3])
            )
            self._write_image(
                os.path.join(dataset, category, "two.png"), _solid(colors[idx % 3])
            )
        return dataset

    def test_init_strips_name_and_reads_weight_url(self) -> None:
        with patch.dict(
            os.environ, {"TF_KERAS_MOBILENET_V2_WEIGHTS_URL": "http://w/x.h5"}
        ):
            process = ClassificationTrainingProcess("  porch ")
        self.assertEqual(process.model_name, "porch")
        self.assertEqual(process.name, "model_training:porch")
        self.assertEqual(process.BASE_WEIGHT_URL, "http://w/x.h5")
        self.assertIsNone(process.stop_event)

    def test_run_exits_with_training_result(self) -> None:
        for result, code in ((True, 0), (False, 1)):
            with self.subTest(result=result):
                process = ClassificationTrainingProcess("porch")
                with (
                    patch.object(process, "pre_run_setup") as setup,
                    patch.object(
                        ClassificationTrainingProcess, TRAIN_METHOD, return_value=result
                    ),
                    patch("builtins.exit") as fake_exit,
                ):
                    process.run()
                setup.assert_called_once()
                fake_exit.assert_called_once_with(code)

    def test_training_requires_two_classes(self) -> None:
        self._dataset("porch", ["only"])
        modules, *_ = _fake_tensorflow()
        process = ClassificationTrainingProcess("porch")
        with (
            patch.dict(sys.modules, modules),
            self.assertLogs(cls.logger, level="ERROR") as logs,
        ):
            self.assertFalse(getattr(process, TRAIN_METHOD)())
        self.assertIn("Need at least 2 classes, found 1", logs.output[0])
        self.assertTrue(os.path.isdir(os.path.join(self.cache, "porch")))

    def test_training_success_writes_model_labelmap_and_metadata(self) -> None:
        dataset = self._dataset("porch", ["dog", "cat"])
        modules, tf, keras, applications, converter = _fake_tensorflow()
        process = ClassificationTrainingProcess("porch")
        with patch.dict(sys.modules, modules):
            self.assertTrue(getattr(process, TRAIN_METHOD)())

        model_dir = os.path.join(self.cache, "porch")
        with open(os.path.join(model_dir, "model.tflite"), "rb") as f:
            self.assertEqual(f.read(), b"tflite-model")
        with open(os.path.join(model_dir, "labelmap.txt")) as f:
            self.assertEqual(f.read(), "dog\ncat\n")
        self.assertEqual(
            read_training_metadata("porch")["last_training_image_count"], 4
        )

        # MobileNetV2 is built from imagenet weights when no URL is configured
        self.assertEqual(
            applications.MobileNetV2.call_args.kwargs["weights"], "imagenet"
        )
        keras.layers.Dense.assert_called_with(2, activation="softmax")
        model = keras.models.Sequential.return_value
        model.fit.assert_called_once()
        self.assertEqual(model.fit.call_args.kwargs["epochs"], cls.EPOCHS)
        self.assertEqual(converter.inference_input_type, tf.uint8)

        # the representative dataset walks the jpg and png images
        samples = list(converter.representative_dataset())
        self.assertEqual(len(samples), 4)
        self.assertEqual(samples[0][0].shape, (1, 224, 224, 3))
        self.assertEqual(samples[0][0].dtype, np.float32)
        self.assertLessEqual(float(samples[0][0].max()), 1.0)
        self.assertTrue(os.path.isdir(dataset))

    def test_training_downloads_weights_when_url_configured(self) -> None:
        self._dataset("porch", ["dog", "cat"])
        modules, _, _, applications, _ = _fake_tensorflow()
        with patch.dict(
            os.environ, {"TF_KERAS_MOBILENET_V2_WEIGHTS_URL": "http://w/x.h5"}
        ):
            process = ClassificationTrainingProcess("porch")
        weights = os.path.join(self.cache, "MobileNet", "mobilenet_v2_weights.h5")
        with (
            patch.dict(sys.modules, modules),
            patch.object(cls.ModelDownloader, "download_from_url") as download,
        ):
            self.assertTrue(getattr(process, TRAIN_METHOD)())
        download.assert_called_once_with("http://w/x.h5", weights)
        self.assertEqual(applications.MobileNetV2.call_args.kwargs["weights"], weights)

    def test_training_skips_download_when_weights_exist(self) -> None:
        self._dataset("porch", ["dog", "cat"])
        weights = os.path.join(self.cache, "MobileNet", "mobilenet_v2_weights.h5")
        os.makedirs(os.path.dirname(weights))
        open(weights, "wb").close()
        modules, *_ = _fake_tensorflow()
        with patch.dict(
            os.environ, {"TF_KERAS_MOBILENET_V2_WEIGHTS_URL": "http://w/x.h5"}
        ):
            process = ClassificationTrainingProcess("porch")
        with (
            patch.dict(sys.modules, modules),
            patch.object(cls.ModelDownloader, "download_from_url") as download,
        ):
            self.assertTrue(getattr(process, TRAIN_METHOD)())
        download.assert_not_called()

    def test_training_fails_on_empty_model(self) -> None:
        self._dataset("porch", ["dog", "cat"])
        modules, *_ = _fake_tensorflow(convert_result=b"")
        process = ClassificationTrainingProcess("porch")
        with (
            patch.dict(sys.modules, modules),
            self.assertLogs(cls.logger, level="ERROR") as logs,
        ):
            self.assertFalse(getattr(process, TRAIN_METHOD)())
        self.assertIn("Model file was not created or is empty", logs.output[0])
        self.assertIsNone(read_training_metadata("porch"))

    def test_training_exception_returns_false(self) -> None:
        modules, *_ = _fake_tensorflow()
        process = ClassificationTrainingProcess("porch")
        with (
            patch.dict(sys.modules, modules),
            self.assertLogs(cls.logger, level="ERROR") as logs,
        ):
            # the dataset directory does not exist
            self.assertFalse(getattr(process, TRAIN_METHOD)())
        self.assertIn("Training failed for porch", logs.output[0])

    def test_representative_dataset_caps_at_300_images(self) -> None:
        dataset = os.path.join(self.clips, "many", "dataset", "a")
        os.makedirs(dataset)
        for idx in range(302):
            open(os.path.join(dataset, f"{idx}.jpg"), "w").close()
        open(os.path.join(dataset, "skip.webp"), "w").close()
        process = ClassificationTrainingProcess("many")
        factory = getattr(process, FACTORY_METHOD)
        with patch.object(cls.cv2, "imread", return_value=_solid((1, 2, 3))) as imread:
            samples = list(factory(os.path.dirname(dataset))())
        self.assertEqual(len(samples), 300)
        self.assertEqual(imread.call_count, 300)


class TestKickoffModelTraining(unittest.TestCase):
    def _run(self, exitcode: int):
        embeddings = MagicMock()
        with (
            patch.object(cls, "InterProcessRequestor") as requestor_cls,
            patch.object(cls, "ClassificationTrainingProcess") as process_cls,
        ):
            process_cls.return_value.exitcode = exitcode
            kickoff_model_training(embeddings, " porch ")
        return embeddings, requestor_cls.return_value, process_cls

    def test_success_reloads_model_and_marks_complete(self) -> None:
        embeddings, requestor, process_cls = self._run(0)
        process_cls.assert_called_once_with("porch")
        process_cls.return_value.start.assert_called_once()
        process_cls.return_value.join.assert_called_once()
        embeddings.send_data.assert_called_once_with(
            EmbeddingsRequestEnum.reload_classification_model.value,
            {"model_name": "porch"},
        )
        states = [c.args for c in requestor.send_data.call_args_list]
        self.assertEqual(
            states,
            [
                (
                    UPDATE_MODEL_STATE,
                    {"model": "porch", "state": ModelStatusTypesEnum.training},
                ),
                (
                    UPDATE_MODEL_STATE,
                    {"model": "porch", "state": ModelStatusTypesEnum.complete},
                ),
            ],
        )
        requestor.stop.assert_called_once()

    def test_failure_marks_failed_without_reload(self) -> None:
        with self.assertLogs(cls.logger, level="ERROR") as logs:
            embeddings, requestor, _ = self._run(1)
        self.assertIn("exit code: 1", logs.output[0])
        embeddings.send_data.assert_not_called()
        self.assertEqual(
            requestor.send_data.call_args_list[-1].args,
            (
                UPDATE_MODEL_STATE,
                {"model": "porch", "state": ModelStatusTypesEnum.failed},
            ),
        )
        requestor.stop.assert_called_once()


def _review(camera: str, start: float, end: float, idx: int = 0) -> SimpleNamespace:
    return SimpleNamespace(id=f"r{idx}", camera=camera, start_time=start, end_time=end)


class TestSelectBalancedTimestamps(unittest.TestCase):
    def setUp(self) -> None:
        cls.random.seed(1234)

    def test_empty_input(self) -> None:
        self.assertEqual(_select_balanced_timestamps([], 10), [])

    def test_samples_inside_middle_of_each_item(self) -> None:
        items = [_review("front", 0.0, 100.0, 0), _review("back", 0.0, 50.0, 1)]
        result = _select_balanced_timestamps(items, target_count=10)
        self.assertEqual(len(result), 2)
        for entry in result:
            item = entry["review_item"]
            duration = item.end_time - item.start_time
            self.assertEqual(entry["camera"], item.camera)
            self.assertGreaterEqual(
                entry["timestamp"], item.start_time + duration * 0.1
            )
            self.assertLessEqual(entry["timestamp"], item.start_time + duration * 0.9)

    def test_zero_duration_items_are_skipped(self) -> None:
        items = [_review("front", 0.0, 100.0, 0), _review("front", 50.0, 50.0, 1)]
        result = _select_balanced_timestamps(items, target_count=1)
        self.assertEqual(len(result), 1)

    def test_tops_up_from_larger_groups(self) -> None:
        six_hours = 6 * 3600
        items = [
            _review("front", 0.0, 1000.0, 0),
            _review("front", 10.0, 1000.0, 1),
            _review("front", 20.0, 1000.0, 2),
            _review("front", six_hours, six_hours + 1000.0, 3),
        ]
        result = _select_balanced_timestamps(items, target_count=3)
        # two groups get one sample each, then the loop adds a third
        self.assertEqual(len(result), 3)
        stamps = sorted(r["timestamp"] for r in result)
        self.assertTrue(all(b - a >= 1.0 for a, b in zip(stamps, stamps[1:])))

    def test_top_up_loop_skips_zero_duration_items(self) -> None:
        valid = _review("front", 0.0, 1000.0, 0)
        empty = _review("front", 10.0, 10.0, 1)
        other = _review("back", 0.0, 1000.0, 2)
        with (
            patch.object(cls.random, "sample", side_effect=lambda pop, k: pop[:k]),
            patch.object(cls.random, "choice", side_effect=[empty, other]) as choice,
        ):
            result = _select_balanced_timestamps([valid, empty, other], 3)
        # the zero duration pick is skipped and the next group fills the gap
        self.assertEqual(choice.call_count, 2)
        self.assertEqual([r["review_item"].id for r in result], ["r0", "r2", "r2"])


class _DbMixin:
    """Bind Recordings and ReviewSegment to a shared in-memory sqlite database."""

    def _setup_db(self) -> None:
        # a shared cache memory database lets worker threads see the same
        # tables while staying off the (slow) disk
        self.db = SqliteDatabase(
            f"file:fork_d70_{uuid.uuid4().hex}?mode=memory&cache=shared", uri=True
        )
        self.models = [Recordings, ReviewSegment]
        ctx = self.db.bind_ctx(self.models)
        ctx.__enter__()
        self.db.create_tables(self.models)
        self.addCleanup(self.db.close)
        self.addCleanup(ctx.__exit__, None, None, None)

    def _recording(self, rec_id: str, camera: str, start: float, end: float) -> None:
        Recordings.create(
            id=rec_id,
            camera=camera,
            path=f"/media/{rec_id}.mp4",
            start_time=start,
            end_time=end,
            duration=end - start,
        )


class TestExtractKeyframes(_TempDirsMixin, _DbMixin, unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        self._setup_db()
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)
        self._recording("rec1", "front", 100.0, 110.0)
        self.frame = _jpeg(_solid((0, 0, 200), 100, 200))

    def test_empty_timestamps(self) -> None:
        self.assertEqual(_extract_keyframes("ffmpeg", [], self.out, {}), [])

    def test_extracts_and_crops_matching_recordings(self) -> None:
        timestamps = [
            {"camera": "front", "timestamp": 105.0},
            {"camera": "nocrop", "timestamp": 105.0},
            {"camera": "front", "timestamp": 500.0},
            {"camera": "front", "timestamp": 101.0},
        ]
        with (
            patch.object(
                cls, "get_image_from_recording", return_value=self.frame
            ) as grab,
            self.assertLogs(cls.logger, level="WARNING") as logs,
        ):
            paths = _extract_keyframes(
                "ffmpeg", timestamps, self.out, {"front": (0.0, 0.0, 0.5, 0.5)}
            )
        self.assertEqual(
            paths,
            [
                os.path.join(self.out, "frame_0000.jpg"),
                os.path.join(self.out, "frame_0003.jpg"),
            ],
        )
        self.assertIn("No crop coordinates for camera nocrop", logs.output[0])
        relative_times = sorted(c.args[2] for c in grab.call_args_list)
        self.assertEqual(relative_times, [1.0, 5.0])
        self.assertEqual(grab.call_args.args[1], "/media/rec1.mp4")
        self.assertEqual(cv2.imread(paths[0]).shape, (224, 224, 3))

    def test_skips_unusable_frames(self) -> None:
        cases = [
            (None, (0.0, 0.0, 0.5, 0.5)),
            (b"not an image", (0.0, 0.0, 0.5, 0.5)),
            (self.frame, (0.5, 0.5, 0.5, 0.9)),
            (RuntimeError("ffmpeg died"), (0.0, 0.0, 0.5, 0.5)),
        ]
        for result, crop in cases:
            with self.subTest(result=result, crop=crop):
                kwargs = (
                    {"side_effect": result}
                    if isinstance(result, Exception)
                    else {"return_value": result}
                )
                with patch.object(cls, "get_image_from_recording", **kwargs):
                    paths = _extract_keyframes(
                        "ffmpeg",
                        [{"camera": "front", "timestamp": 105.0}],
                        self.out,
                        {"front": crop},
                    )
                self.assertEqual(paths, [])


class TestSelectDistinctImages(_TempDirsMixin, unittest.TestCase):
    def test_short_list_is_returned_unchanged(self) -> None:
        paths = ["a.jpg", "b.jpg"]
        self.assertIs(_select_distinct_images(paths, target_count=2), paths)

    def test_unreadable_images_are_dropped(self) -> None:
        good = self._write_image(os.path.join(self.tmp, "g.jpg"), _solid((0, 0, 255)))
        missing = os.path.join(self.tmp, "missing.jpg")
        self.assertEqual(
            _select_distinct_images([good, missing, missing], target_count=2), [good]
        )

    def test_processing_errors_are_skipped(self) -> None:
        good = self._write_image(os.path.join(self.tmp, "g.jpg"), _solid((0, 0, 255)))
        bad = os.path.join(self.tmp, "bad.jpg")
        real_imread = cv2.imread

        def fake_imread(path, *args):
            if path == bad:
                raise cv2.error("corrupt")
            return real_imread(path, *args)

        with patch.object(cls.cv2, "imread", side_effect=fake_imread):
            self.assertEqual(_select_distinct_images([good, bad], 1), [good])

    def test_greedy_selection_prefers_different_images(self) -> None:
        red = self._write_image(os.path.join(self.tmp, "r.png"), _solid((0, 0, 255)))
        red2 = self._write_image(os.path.join(self.tmp, "r2.png"), _solid((0, 0, 255)))
        blue = self._write_image(os.path.join(self.tmp, "b.png"), _solid((255, 0, 0)))
        green = self._write_image(os.path.join(self.tmp, "g.png"), _solid((0, 255, 0)))
        with patch.object(cls.random, "choice", side_effect=lambda seq: seq[0]):
            selected = _select_distinct_images([red, red2, blue, green], target_count=3)
        self.assertEqual(selected[0], red)
        self.assertEqual(set(selected), {red, blue, green})


class TestCollectStateExamples(_TempDirsMixin, _DbMixin, unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        self._setup_db()

    def _review_segment(self, rid: str, camera: str, start: float, end) -> None:
        ReviewSegment.create(
            id=rid,
            camera=camera,
            start_time=start,
            end_time=end,
            severity="alert",
            thumb_path=f"/thumbs/{rid}.webp",
            data={},
        )

    def test_no_review_items_returns_early(self) -> None:
        self._review_segment("elsewhere", "back", 0.0, 10.0)
        with self.assertLogs(cls.logger, level="WARNING"):
            collect_state_classification_examples("gate", {"front": (0, 0, 1, 1)})
        self.assertFalse(os.path.exists(os.path.join(self.clips, "gate")))

    def test_pipeline_writes_train_examples(self) -> None:
        self._review_segment("r1", "front", 100.0, 110.0)
        self._review_segment("r2", "front", 200.0, 210.0)
        self._review_segment("other", "back", 100.0, 110.0)
        Recordings.create(
            id="rec1",
            camera="front",
            path="/media/rec1.mp4",
            start_time=90.0,
            end_time=300.0,
            duration=210.0,
        )
        stale = os.path.join(self.clips, "gate", "train", "old.jpg")
        self._write_image(stale, _solid((1, 1, 1)))
        frame = _jpeg(_solid((0, 200, 0), 100, 200))
        with patch.object(cls, "get_image_from_recording", return_value=frame) as grab:
            collect_state_classification_examples(" gate ", {"front": (0, 0, 1, 1)})
        self.assertEqual(grab.call_count, 2)
        train = os.path.join(self.clips, "gate", "train")
        self.assertEqual(
            sorted(os.listdir(train)), ["example_000.jpg", "example_001.jpg"]
        )
        self.assertFalse(os.path.exists(stale))
        self.assertFalse(
            os.path.exists(os.path.join(self.clips, "gate", "dataset", "temp"))
        )

    def test_save_and_cleanup_failures_are_logged(self) -> None:
        self._review_segment("r1", "front", 100.0, 110.0)
        good = self._write_image(os.path.join(self.tmp, "k.jpg"), _solid((0, 0, 9)))
        boom = os.path.join(self.tmp, "boom.jpg")
        missing = os.path.join(self.tmp, "missing.jpg")
        real_imread = cv2.imread
        real_rmtree = shutil.rmtree

        def fake_imread(path, *args):
            if path == boom:
                raise cv2.error("corrupt")
            return real_imread(path, *args)

        def fake_rmtree(path, *args, **kwargs):
            if path.endswith("temp"):
                raise OSError("busy")
            return real_rmtree(path, *args, **kwargs)

        with (
            patch.object(cls, "_extract_keyframes", return_value=[good, boom, missing]),
            patch.object(cls.cv2, "imread", side_effect=fake_imread),
            patch.object(cls.shutil, "rmtree", side_effect=fake_rmtree),
            self.assertLogs(cls.logger, level="WARNING") as logs,
        ):
            collect_state_classification_examples("gate", {"front": (0, 0, 1, 1)})
        train = os.path.join(self.clips, "gate", "train")
        self.assertEqual(os.listdir(train), ["example_000.jpg"])
        joined = "\n".join(logs.output)
        self.assertIn("Failed to save image", joined)
        self.assertIn("Failed to clean up temp directory", joined)


def _event(idx: int, camera: str = "front", start: float = 0.0, data=None):
    return SimpleNamespace(
        id=f"e{idx}", camera=camera, start_time=start, data=data, label="person"
    )


class TestSelectBalancedEvents(unittest.TestCase):
    def setUp(self) -> None:
        cls.random.seed(99)

    def test_empty(self) -> None:
        self.assertEqual(_select_balanced_events([], 10), [])

    def test_prefers_high_scores_per_group(self) -> None:
        six_hours = 6 * 3600
        events = [_event(i, "front", 0.0, {"score": i / 10}) for i in range(1, 10)] + [
            _event(20, "back", six_hours, None)
        ]
        result = _select_balanced_events(events, target_count=2)
        self.assertEqual(len(result), 2)
        front = [e for e in result if e.camera == "front"]
        self.assertEqual(len(front), 1)
        # one per group drawn from the top three scores
        self.assertGreaterEqual(front[0].data["score"], 0.7)

    def test_tops_up_from_remaining_events(self) -> None:
        cameras = ["cam0"] * 6 + ["cam1"] * 2 + ["cam2"] * 2
        events = [_event(i, cam, 0.0, {"score": 0.5}) for i, cam in enumerate(cameras)]
        # three groups get two picks each, then two more come from the rest
        result = _select_balanced_events(events, target_count=8)
        self.assertEqual(len(result), 8)
        self.assertEqual(len({e.id for e in result}), 8)

    def test_takes_all_when_not_enough(self) -> None:
        events = [_event(i, f"cam{i}", 0.0, {}) for i in range(3)]
        result = _select_balanced_events(events, target_count=10)
        self.assertEqual(sorted(e.id for e in result), ["e0", "e1", "e2"])


class TestEventCrops(_TempDirsMixin, unittest.TestCase):
    def test_snapshot_crop_follows_box(self) -> None:
        snapshot = np.zeros((100, 200, 3), np.uint8)
        snapshot[40:60, 80:120] = 255
        event = _event(1, data={"box": [0.4, 0.4, 0.2, 0.2]})
        with patch.object(
            cls, "load_event_snapshot_image", return_value=(snapshot, True)
        ) as load:
            crop = _load_event_classification_crop(event)
        load.assert_called_once_with(event, clean_only=True)
        # a square crop sized to the longest box edge, centered on the box
        self.assertEqual(crop.shape, (40, 40, 3))
        self.assertTrue(np.all(crop[10:30, 0:40] == 255))

    def test_thumbnail_fallbacks(self) -> None:
        thumb = _jpeg(_solid((10, 20, 30), 100, 100))
        cases = [
            ({"box": [0, 0, 0.1, 0.1], "region": [0, 0, 1, 1]}, 40),
            ({"box": [0, 0, 0.25, 0.3], "region": [0, 0, 1, 1]}, 50),
            ({"box": [0, 0, 0.4, 0.4], "region": [0, 0, 1, 1]}, 65),
            ({"box": [0, 0, 0.5, 0.5], "region": [0, 0, 1, 1]}, 80),
            ({"box": [0, 0, 0.8, 0.8], "region": [0, 0, 1, 1]}, 95),
            ({"box": [0, 0, 0.5], "region": [0, 0, 1, 1]}, 100),
            ({"region": [0, 0, 1, 1]}, 100),
            (None, 100),
        ]
        for data, expected in cases:
            with self.subTest(data=data):
                with (
                    patch.object(
                        cls, "load_event_snapshot_image", return_value=(None, False)
                    ),
                    patch.object(cls, "get_event_thumbnail_bytes", return_value=thumb),
                ):
                    crop = _load_event_classification_crop(_event(1, data=data))
                self.assertEqual(crop.shape[:2], (expected, expected))

    def test_missing_or_invalid_thumbnail(self) -> None:
        for thumb in (None, b"", b"garbage"):
            with self.subTest(thumb=thumb):
                with patch.object(cls, "get_event_thumbnail_bytes", return_value=thumb):
                    self.assertIsNone(_load_event_classification_crop(_event(1)))

    def test_tiny_thumbnail_crops_to_nothing(self) -> None:
        thumb = _jpeg(_solid((10, 20, 30), 1, 1))
        data = {"box": [0, 0, 0.1, 0.1], "region": [0, 0, 1, 1]}
        with (
            patch.object(cls, "load_event_snapshot_image", return_value=(None, False)),
            patch.object(cls, "get_event_thumbnail_bytes", return_value=thumb),
        ):
            self.assertIsNone(_load_event_classification_crop(_event(1, data=data)))

    def test_extract_event_thumbnails(self) -> None:
        out = os.path.join(self.tmp, "thumbs")
        os.makedirs(out)
        events = [_event(0), _event(1), _event(2)]
        crops = [_solid((0, 0, 255)), None, RuntimeError("bad")]
        with patch.object(cls, "_load_event_classification_crop", side_effect=crops):
            paths = _extract_event_thumbnails(events, out)
        self.assertEqual(paths, [os.path.join(out, "thumbnail_0000.jpg")])
        self.assertEqual(cv2.imread(paths[0]).shape, (224, 224, 3))


class TestCollectObjectExamples(_TempDirsMixin, unittest.TestCase):
    def _patch_events(self, events):
        event_model = MagicMock()
        event_model.select.return_value.where.return_value.order_by.return_value = (
            events
        )
        return patch.object(cls, "Event", event_model)

    def test_no_events_returns_early(self) -> None:
        with self._patch_events([]), self.assertLogs(cls.logger, level="WARNING"):
            collect_object_classification_examples("pets", "dog")
        self.assertFalse(os.path.exists(os.path.join(self.clips, "pets", "train")))
        self.assertTrue(
            os.path.isdir(os.path.join(self.clips, "pets", "dataset", "temp"))
        )

    def test_pipeline_writes_train_examples(self) -> None:
        events = [_event(i, data={"score": 0.9}) for i in range(3)]
        thumb = _jpeg(_solid((10, 120, 30), 60, 60))
        stale = os.path.join(self.clips, "pets", "train", "old.jpg")
        self._write_image(stale, _solid((1, 1, 1)))
        with (
            self._patch_events(events),
            patch.object(cls, "load_event_snapshot_image", return_value=(None, False)),
            patch.object(cls, "get_event_thumbnail_bytes", return_value=thumb),
        ):
            collect_object_classification_examples(" pets ", "dog")
        train = os.path.join(self.clips, "pets", "train")
        self.assertEqual(
            sorted(os.listdir(train)),
            ["example_000.jpg", "example_001.jpg", "example_002.jpg"],
        )
        self.assertEqual(
            cv2.imread(os.path.join(train, "example_000.jpg")).shape, (224, 224, 3)
        )
        self.assertFalse(
            os.path.exists(os.path.join(self.clips, "pets", "dataset", "temp"))
        )

    def test_save_and_cleanup_failures_are_logged(self) -> None:
        good = self._write_image(os.path.join(self.tmp, "k.jpg"), _solid((0, 0, 9)))
        boom = os.path.join(self.tmp, "boom.jpg")
        real_imread = cv2.imread
        real_rmtree = shutil.rmtree

        def fake_imread(path, *args):
            if path == boom:
                raise cv2.error("corrupt")
            return real_imread(path, *args)

        def fake_rmtree(path, *args, **kwargs):
            if path.endswith("temp"):
                raise OSError("busy")
            return real_rmtree(path, *args, **kwargs)

        with (
            self._patch_events([_event(0)]),
            patch.object(cls, "_extract_event_thumbnails", return_value=[good, boom]),
            patch.object(cls.cv2, "imread", side_effect=fake_imread),
            patch.object(cls.shutil, "rmtree", side_effect=fake_rmtree),
            self.assertLogs(cls.logger, level="WARNING") as logs,
        ):
            collect_object_classification_examples("pets", "dog")
        train = os.path.join(self.clips, "pets", "train")
        self.assertEqual(os.listdir(train), ["example_000.jpg"])
        joined = "\n".join(logs.output)
        self.assertIn("Failed to save image", joined)
        self.assertIn("Failed to clean up temp directory", joined)


if __name__ == "__main__":
    unittest.main()
