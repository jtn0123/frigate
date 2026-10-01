"""Coverage for the custom state and object classification processors (fork D73).

The TFLite interpreter is replaced with a fake, the deferred worker thread is
never started (tasks are run synchronously through ``_process_task``) and the
model and training directories live in a private temporary directory.
"""

import os
import shutil
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np

# Mock TFLite before importing the classification module
for _mod in (
    "tflite_runtime",
    "tflite_runtime.interpreter",
    "ai_edge_litert",
    "ai_edge_litert.interpreter",
):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

from frigate.comms.embeddings_updater import EmbeddingsRequestEnum  # noqa: E402
from frigate.config.classification import (  # noqa: E402
    CustomClassificationConfig,
    CustomClassificationObjectConfig,
    CustomClassificationStateCameraConfig,
    CustomClassificationStateConfig,
)
from frigate.data_processing.real_time import api as api_module  # noqa: E402
from frigate.data_processing.real_time import custom_classification as cc  # noqa: E402
from frigate.data_processing.real_time.custom_classification import (  # noqa: E402
    MAX_OBJECT_CLASSIFICATIONS,
    CustomObjectClassificationProcessor,
    CustomStateClassificationProcessor,
    write_classification_attempt,
)

MODEL = "door"
CAMERA = "front"
WIDTH = 320
HEIGHT = 240
RELOAD_TOPIC = EmbeddingsRequestEnum.reload_classification_model.value


class FakeInterpreter:
    """Stand-in for the TFLite interpreter returning a fixed probability row."""

    instances: list["FakeInterpreter"] = []

    def __init__(self, model_path: str, num_threads: int) -> None:
        self.model_path = model_path
        self.num_threads = num_threads
        self.allocated = False
        self.inputs: list[tuple[int, np.ndarray]] = []
        self.invocations = 0
        self.output = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)
        FakeInterpreter.instances.append(self)

    def allocate_tensors(self) -> None:
        self.allocated = True

    def get_input_details(self) -> list[dict[str, Any]]:
        return [{"index": 3}]

    def get_output_details(self) -> list[dict[str, Any]]:
        return [{"index": 7}]

    def set_tensor(self, index: int, value: np.ndarray) -> None:
        self.inputs.append((index, value))

    def invoke(self) -> None:
        self.invocations += 1

    def get_tensor(self, index: int) -> np.ndarray:
        return self.output


def _frame() -> np.ndarray:
    """A YUV I420 frame of the detect resolution with a bright patch."""
    frame = np.full((HEIGHT * 3 // 2, WIDTH), 128, dtype=np.uint8)
    frame[0:HEIGHT, 0 : WIDTH // 2] = 200
    return frame


def _frigate_config() -> SimpleNamespace:
    detect = SimpleNamespace(width=WIDTH, height=HEIGHT)
    return SimpleNamespace(cameras={CAMERA: SimpleNamespace(detect=detect)})


def _metrics(name: str = MODEL) -> SimpleNamespace:
    return SimpleNamespace(
        classification_speeds={name: SimpleNamespace(value=0.0)},
        classification_cps={name: SimpleNamespace(value=0.0)},
    )


class _ProcessorTestBase(unittest.TestCase):
    """Temporary dirs, a fake interpreter and no worker thread."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.model_cache = os.path.join(self.tmp, "model_cache")
        self.clips = os.path.join(self.tmp, "clips")
        FakeInterpreter.instances = []
        patches = [
            patch.object(cc, "MODEL_CACHE_DIR", self.model_cache),
            patch.object(cc, "CLIPS_DIR", self.clips),
            patch.object(cc, "Interpreter", FakeInterpreter),
            # Never start the deferred worker; tasks run synchronously in tests.
            patch.object(
                api_module,
                "threading",
                SimpleNamespace(
                    Thread=MagicMock(),
                    Lock=threading.Lock,
                    Event=threading.Event,
                ),
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write_model(self, name: str = MODEL, labels: str = "open\nclosed\nnone\n"):
        model_dir = os.path.join(self.model_cache, name)
        os.makedirs(model_dir, exist_ok=True)
        with open(os.path.join(model_dir, "model.tflite"), "wb") as f:
            f.write(b"tflite")
        with open(os.path.join(model_dir, "labelmap.txt"), "w") as f:
            f.write(labels)

    def train_files(self, name: str = MODEL) -> list[str]:
        folder = os.path.join(self.clips, name, "train")
        if not os.path.isdir(folder):
            return []
        return sorted(os.listdir(folder))

    @staticmethod
    def run_queued(proc: Any) -> None:
        """Drain the task queue on the calling thread."""
        while not proc._task_queue.empty():
            proc._process_task(proc._task_queue.get_nowait())

    @staticmethod
    def sync_requests(proc: Any) -> None:
        proc._enqueue_request = lambda func, args, timeout=10.0: func(args)


class TestStateProcessorInit(_ProcessorTestBase):
    def _model_config(self, **kwargs: Any) -> CustomClassificationConfig:
        return CustomClassificationConfig(
            name=kwargs.pop("name", MODEL),
            state_config=CustomClassificationStateConfig(
                cameras={
                    CAMERA: CustomClassificationStateCameraConfig(
                        crop=[0.0, 0.0, 0.5, 0.5]
                    )
                },
                interval=10,
            ),
            **kwargs,
        )

    def test_missing_name_raises(self):
        with self.assertRaises(ValueError):
            CustomStateClassificationProcessor(
                _frigate_config(),
                CustomClassificationConfig(),
                MagicMock(),
                _metrics(),
            )

    def test_without_model_files_leaves_interpreter_unset(self):
        proc = CustomStateClassificationProcessor(
            _frigate_config(), self._model_config(), MagicMock(), None
        )
        self.assertIsNone(proc.interpreter)
        self.assertIsNone(proc.tensor_input_details)
        self.assertEqual(proc.labelmap, {})
        self.assertIsNone(proc.inference_speed)
        self.assertEqual(proc.model_dir, os.path.join(self.model_cache, MODEL))
        self.assertEqual(proc.train_dir, os.path.join(self.clips, MODEL, "train"))
        proc.expire_object("obj", CAMERA)

    def test_with_model_files_builds_interpreter_and_labels(self):
        self.write_model()
        proc = CustomStateClassificationProcessor(
            _frigate_config(), self._model_config(), MagicMock(), _metrics()
        )
        self.assertIsInstance(proc.interpreter, FakeInterpreter)
        self.assertTrue(proc.interpreter.allocated)
        self.assertEqual(proc.interpreter.num_threads, 2)
        self.assertEqual(proc.tensor_input_details, [{"index": 3}])
        self.assertEqual(proc.tensor_output_details, [{"index": 7}])
        self.assertEqual(proc.labelmap, {0: "open", 1: "closed", 2: "none"})
        self.assertIsNotNone(proc.inference_speed)


class TestStateVerification(_ProcessorTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.proc = CustomStateClassificationProcessor(
            _frigate_config(),
            CustomClassificationConfig(name=MODEL),
            MagicMock(),
            None,
        )

    def test_should_save_image_rules(self):
        proc = self.proc
        self.assertTrue(proc._should_save_image(CAMERA, "open"))
        proc.state_history[CAMERA] = {
            "current_state": "open",
            "pending_state": "closed",
            "consecutive_count": 1,
        }
        self.assertTrue(proc._should_save_image(CAMERA, "open"))
        proc.state_history[CAMERA]["pending_state"] = None
        self.assertTrue(proc._should_save_image(CAMERA, "closed"))
        self.assertTrue(proc._should_save_image(CAMERA, "open", 0.9))
        self.assertFalse(proc._should_save_image(CAMERA, "open", 1.0))

    def test_verify_state_change_needs_three_consecutive(self):
        proc = self.proc
        self.assertIsNone(proc.verify_state_change(CAMERA, "open"))
        self.assertEqual(proc.state_history[CAMERA]["consecutive_count"], 1)
        self.assertIsNone(proc.verify_state_change(CAMERA, "open"))
        self.assertEqual(proc.verify_state_change(CAMERA, "open"), "open")
        self.assertEqual(proc.state_history[CAMERA]["current_state"], "open")
        # same as current resets any pending change
        self.assertIsNone(proc.verify_state_change(CAMERA, "closed"))
        self.assertIsNone(proc.verify_state_change(CAMERA, "open"))
        self.assertIsNone(proc.state_history[CAMERA]["pending_state"])
        self.assertEqual(proc.state_history[CAMERA]["consecutive_count"], 0)
        # a different pending state restarts the count
        proc.verify_state_change(CAMERA, "closed")
        proc.verify_state_change(CAMERA, "closed")
        proc.verify_state_change(CAMERA, "half")
        self.assertEqual(proc.state_history[CAMERA]["pending_state"], "half")
        self.assertEqual(proc.state_history[CAMERA]["consecutive_count"], 1)


class TestStateProcessFrame(_ProcessorTestBase):
    def _make(
        self,
        crop: list[float] | None = None,
        interval: int | None = 10,
        motion: bool = False,
        with_model: bool = True,
        **kwargs: Any,
    ) -> CustomStateClassificationProcessor:
        if with_model:
            self.write_model()
        model_config = CustomClassificationConfig(
            name=MODEL,
            state_config=CustomClassificationStateConfig(
                cameras={
                    CAMERA: CustomClassificationStateCameraConfig(
                        crop=crop or [0.0, 0.0, 0.5, 0.5]
                    )
                },
                interval=interval,
                motion=motion,
            ),
            **kwargs,
        )
        self.metrics = _metrics()
        proc = CustomStateClassificationProcessor(
            _frigate_config(), model_config, MagicMock(), self.metrics
        )
        return proc

    def test_returns_early_without_model_details(self):
        proc = self._make(with_model=False)
        proc.process_frame({"camera": CAMERA}, _frame())
        self.assertTrue(proc._task_queue.empty())

    def test_unknown_camera_is_ignored_but_cps_updated(self):
        proc = self._make()
        self.metrics.classification_cps[MODEL].value = -1
        proc.process_frame({"camera": "back"}, _frame())
        self.assertTrue(proc._task_queue.empty())
        self.assertEqual(self.metrics.classification_cps[MODEL].value, 0.0)

    def test_interval_elapsed_enqueues_classify_task(self):
        proc = self._make()
        proc.last_run = 0
        proc.process_frame({"camera": CAMERA}, _frame())
        task = proc._task_queue.get_nowait()
        self.assertEqual(task[0], "classify")
        self.assertEqual(task[1], CAMERA)
        self.assertEqual(task[3].shape, (224, 224, 3))
        # crop is half of each dimension
        self.assertEqual(task[4].shape, (HEIGHT // 2, WIDTH // 2, 3))
        self.assertGreater(proc.last_run, 0)

    def test_not_due_does_not_enqueue(self):
        proc = self._make()
        proc.last_run = 1e12
        proc.process_frame({"camera": CAMERA, "motion": []}, _frame())
        self.assertTrue(proc._task_queue.empty())

    def test_motion_overlapping_crop_triggers_run(self):
        proc = self._make(interval=None, motion=True)
        proc.last_run = 0
        frame_data = {"camera": CAMERA, "motion": [[10, 10, 50, 50]]}
        proc.process_frame(frame_data, _frame())
        self.assertEqual(proc._task_queue.qsize(), 1)

    def test_motion_within_one_second_is_throttled(self):
        proc = self._make(interval=None, motion=True)
        proc.last_run = 1e12
        frame_data = {"camera": CAMERA, "motion": [[10, 10, 50, 50]]}
        proc.process_frame(frame_data, _frame())
        self.assertTrue(proc._task_queue.empty())

    def test_pending_state_forces_verification_run(self):
        proc = self._make(interval=None)
        proc.last_run = 0
        proc.state_history[CAMERA] = {
            "current_state": "open",
            "pending_state": "closed",
            "consecutive_count": 1,
        }
        proc.process_frame({"camera": CAMERA}, _frame())
        self.assertEqual(proc._task_queue.qsize(), 1)

    def test_invalid_crop_logs_warning(self):
        proc = self._make(crop=[0.5, 0.5, 0.5, 0.9])
        proc.last_run = 0
        with self.assertLogs(cc.logger, level="WARNING") as logs:
            proc.process_frame({"camera": CAMERA}, _frame())
        self.assertIn("Invalid crop coordinates", logs.output[0])
        self.assertTrue(proc._task_queue.empty())

    def test_resize_failure_logs_warning(self):
        proc = self._make()
        proc.last_run = 0
        with (
            patch.object(cc.cv2, "resize", side_effect=Exception("boom")),
            self.assertLogs(cc.logger, level="WARNING") as logs,
        ):
            proc.process_frame({"camera": CAMERA}, _frame())
        self.assertIn("Failed to resize", logs.output[0])
        self.assertTrue(proc._task_queue.empty())


class TestStateClassify(_ProcessorTestBase):
    def _make(self, with_model: bool = True, **kwargs: Any):
        if with_model:
            self.write_model()
        model_config = CustomClassificationConfig(name=MODEL, **kwargs)
        self.metrics = _metrics()
        return CustomStateClassificationProcessor(
            _frigate_config(), model_config, MagicMock(), self.metrics
        )

    def _task(self, ts: float = 100.0) -> tuple:
        resized = np.zeros((224, 224, 3), dtype=np.uint8)
        crop = np.full((20, 20, 3), 50, dtype=np.uint8)
        return ("classify", CAMERA, ts, resized, crop)

    def test_no_interpreter_saves_unknown_attempt(self):
        proc = self._make(with_model=False)
        proc._process_task(self._task())
        self.assertEqual(self.train_files(), ["none-none-100.0-unknown-0.0.webp"])
        self.assertEqual(proc.drain_results(), [])

    def test_no_interpreter_respects_save_attempts(self):
        proc = self._make(with_model=False, save_attempts=1)
        proc._process_task(self._task(1.0))
        proc._process_task(self._task(2.0))
        self.assertEqual(len(self.train_files()), 1)

    def test_no_interpreter_stable_state_still_saves(self):
        proc = self._make(with_model=False)
        proc.state_history[CAMERA] = {
            "current_state": "unknown",
            "pending_state": None,
            "consecutive_count": 0,
        }
        with patch.object(cc, "write_classification_attempt") as write:
            proc._process_task(self._task())
        # score 0.0 is always below 1.0, so it still saves
        write.assert_called_once()

    def test_missing_tensor_details_returns(self):
        proc = self._make()
        proc.tensor_output_details = None
        proc._process_task(self._task())
        self.assertEqual(proc.interpreter.invocations, 0)

    def test_three_confident_results_emit_state(self):
        proc = self._make(save_attempts=50)
        for ts in (1.0, 2.0, 3.0):
            proc._process_task(self._task(ts))
        self.assertEqual(proc.interpreter.invocations, 3)
        index, tensor = proc.interpreter.inputs[0]
        self.assertEqual(index, 3)
        self.assertEqual(tensor.shape, (1, 224, 224, 3))
        self.assertEqual(
            proc.drain_results(),
            [
                {
                    "type": "classification",
                    "processor": "state",
                    "model_name": MODEL,
                    "camera": CAMERA,
                    "state": "open",
                }
            ],
        )
        # first sight and the two pending verifications save training images
        self.assertEqual(len(self.train_files()), 3)
        self.assertNotEqual(self.metrics.classification_speeds[MODEL].value, 0.0)
        # stable state at 100% no longer saves
        proc._process_task(self._task(4.0))
        self.assertEqual(len(self.train_files()), 3)

    def test_low_score_skips_verification(self):
        proc = self._make()
        proc.interpreter.output = np.array([[0.5, 0.3, 0.2]], dtype=np.float32)
        with self.assertLogs(cc.logger, level="DEBUG") as logs:
            proc._process_task(self._task())
        self.assertTrue(any("below threshold" in line for line in logs.output))
        self.assertNotIn(CAMERA, proc.state_history)
        self.assertEqual(self.train_files(), ["none-none-100.0-open-0.5.webp"])

    def test_reload_task_rebuilds_detector(self):
        proc = self._make(with_model=False)
        self.assertIsNone(proc.interpreter)
        self.write_model()
        proc._process_task(("reload",))
        self.assertIsInstance(proc.interpreter, FakeInterpreter)
        proc._process_task(("unknown",))

    def test_handle_request_reloads_matching_model(self):
        proc = self._make(with_model=False)
        self.sync_requests(proc)
        self.write_model()
        result = proc.handle_request(RELOAD_TOPIC, {"model_name": MODEL})
        self.assertEqual(result, {"success": True, "message": f"Loaded {MODEL} model."})
        self.assertIsNotNone(proc.interpreter)
        self.assertIsNone(proc.handle_request(RELOAD_TOPIC, {"model_name": "x"}))
        self.assertIsNone(proc.handle_request("other", {"model_name": MODEL}))


class TestObjectProcessor(_ProcessorTestBase):
    def _make(
        self, with_model: bool = True, metrics: Any = "default", **kwargs: Any
    ) -> CustomObjectClassificationProcessor:
        if with_model:
            self.write_model()
        model_config = CustomClassificationConfig(
            name=MODEL,
            object_config=CustomClassificationObjectConfig(objects=["dog"]),
            **kwargs,
        )
        self.metrics = _metrics() if metrics == "default" else metrics
        self.publisher = MagicMock()
        return CustomObjectClassificationProcessor(
            _frigate_config(), model_config, self.publisher, MagicMock(), self.metrics
        )

    def _obj(self, **overrides: Any) -> dict[str, Any]:
        obj = {
            "id": "obj1",
            "label": "dog",
            "false_positive": False,
            "end_time": None,
            "box": [20, 20, 80, 100],
            "camera": CAMERA,
        }
        obj.update(overrides)
        return obj

    def _task(self, object_id: str = "obj1", ts: float = 10.0) -> tuple:
        resized = np.zeros((224, 224, 3), dtype=np.uint8)
        crop = np.full((20, 20, 3), 90, dtype=np.uint8)
        return ("classify", object_id, CAMERA, ts, resized, crop)

    def test_missing_name_raises(self):
        with self.assertRaises(ValueError):
            CustomObjectClassificationProcessor(
                _frigate_config(),
                CustomClassificationConfig(),
                MagicMock(),
                MagicMock(),
                _metrics(),
            )

    def test_build_detector_with_and_without_model(self):
        proc = self._make(with_model=False, metrics=None)
        self.assertIsNone(proc.interpreter)
        self.assertIsNone(proc.inference_speed)
        proc = self._make()
        self.assertIsInstance(proc.interpreter, FakeInterpreter)
        self.assertEqual(proc.labelmap[1], "closed")
        self.assertIsNotNone(proc.inference_speed)

    def test_process_frame_gating(self):
        proc = self._make()
        proc.process_frame(self._obj(false_positive=True), _frame())
        proc.process_frame(self._obj(label="cat"), _frame())
        proc.process_frame(self._obj(end_time=5.0), _frame())
        proc.classification_history["obj1"] = [
            ("open", 1.0, 0.0)
        ] * MAX_OBJECT_CLASSIFICATIONS
        proc.process_frame(self._obj(), _frame())
        self.assertTrue(proc._task_queue.empty())

    def test_process_frame_without_details_returns(self):
        proc = self._make(with_model=False)
        proc.process_frame(self._obj(), _frame())
        self.assertTrue(proc._task_queue.empty())

    def test_process_frame_enqueues_crop(self):
        proc = self._make()
        self.metrics.classification_cps[MODEL].value = -1
        proc.process_frame(self._obj(), _frame())
        task = proc._task_queue.get_nowait()
        self.assertEqual(task[0], "classify")
        self.assertEqual(task[1], "obj1")
        self.assertEqual(task[2], CAMERA)
        self.assertEqual(task[4].shape, (224, 224, 3))
        self.assertEqual(task[5].ndim, 3)
        self.assertEqual(self.metrics.classification_cps[MODEL].value, 0.0)

    def test_process_frame_resize_failure(self):
        proc = self._make()
        with (
            patch.object(cc.cv2, "resize", side_effect=Exception("bad")),
            self.assertLogs(cc.logger, level="WARNING") as logs,
        ):
            proc.process_frame(self._obj(), _frame())
        self.assertIn("Failed to resize", logs.output[0])
        self.assertTrue(proc._task_queue.empty())

    def test_no_interpreter_tracks_unknown_history(self):
        proc = self._make(with_model=False)
        proc._process_task(self._task(ts=1.0))
        proc._process_task(self._task(ts=2.0))
        self.assertEqual(
            proc.classification_history["obj1"],
            [("unknown", 0.0, 1.0), ("unknown", 0.0, 2.0)],
        )
        self.assertEqual(
            self.train_files(),
            ["obj1-1.0-unknown-0.0.webp", "obj1-2.0-unknown-0.0.webp"],
        )

    def test_missing_tensor_details_returns(self):
        proc = self._make()
        proc.tensor_input_details = None
        proc._process_task(self._task())
        self.assertEqual(proc.interpreter.invocations, 0)

    def test_consensus_emits_after_three_attempts(self):
        proc = self._make()
        proc.interpreter.output = np.array([[1.0, 9.0, 0.0]], dtype=np.float32)
        for ts in (1.0, 2.0):
            proc._process_task(self._task(ts=ts))
        self.assertEqual(proc.drain_results(), [])
        proc._process_task(self._task(ts=3.0))
        results = proc.drain_results()
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["label"], "closed")
        self.assertAlmostEqual(results[0]["score"], 0.9)
        self.assertEqual(results[0]["classification_type"], "sub_label")
        self.assertEqual(results[0]["object_id"], "obj1")
        self.assertEqual(results[0]["timestamp"], 3.0)
        self.assertEqual(len(self.train_files()), 3)

    def test_below_threshold_saves_but_skips_consensus(self):
        proc = self._make()
        proc.interpreter.output = np.array([[0.25, 0.75, 0.0]], dtype=np.float32)
        proc._process_task(self._task())
        self.assertNotIn("obj1", proc.classification_history)
        self.assertEqual(self.train_files(), ["obj1-10.0-closed-0.75.webp"])

    def test_expire_and_reload_tasks(self):
        proc = self._make(with_model=False)
        proc.classification_history["obj1"] = [("a", 1.0, 1.0)]
        proc.expire_object("obj1", CAMERA)
        self.run_queued(proc)
        self.assertNotIn("obj1", proc.classification_history)
        proc._process_task(("expire", "missing"))
        self.write_model()
        proc._process_task(("reload",))
        self.assertIsNotNone(proc.interpreter)
        proc._process_task(("noop",))

    def test_handle_request(self):
        proc = self._make(with_model=False)
        self.sync_requests(proc)
        self.write_model()
        self.assertEqual(
            proc.handle_request(RELOAD_TOPIC, {"model_name": MODEL}),
            {"success": True, "message": f"Loaded {MODEL} model."},
        )
        self.assertIsInstance(proc.interpreter, FakeInterpreter)
        self.assertIsNone(proc.handle_request(RELOAD_TOPIC, {"model_name": "x"}))
        self.assertIsNone(proc.handle_request("nope", {}))


class TestWeightedScore(_ProcessorTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.proc = CustomObjectClassificationProcessor(
            _frigate_config(),
            CustomClassificationConfig(name=MODEL),
            MagicMock(),
            MagicMock(),
            None,
        )

    def test_needs_three_entries(self):
        self.assertEqual(self.proc.get_weighted_score("o", "a", 0.9, 1.0), (None, 0.0))
        self.assertEqual(self.proc.get_weighted_score("o", "a", 0.8, 2.0), (None, 0.0))
        label, score = self.proc.get_weighted_score("o", "a", 0.7, 3.0)
        self.assertEqual(label, "a")
        self.assertAlmostEqual(score, 0.8)

    def test_no_consensus(self):
        for label in ("a", "b", "c"):
            result = self.proc.get_weighted_score("o", label, 0.9, 1.0)
        self.assertEqual(result, (None, 0.0))

    def test_none_label_is_filtered(self):
        for _ in range(3):
            result = self.proc.get_weighted_score("o", "none", 0.9, 1.0)
        self.assertEqual(result, (None, 0.0))


class TestWriteClassificationAttempt(unittest.TestCase):
    def test_writes_and_trims(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "nested", "train")
            frame = np.full((8, 8, 3), 100, dtype=np.uint8)
            write_classification_attempt(
                folder, frame, "evt", 1.5, "half-open", 0.75, max_files=5
            )
            self.assertEqual(os.listdir(folder), ["evt-1.5-half_open-0.75.webp"])
            with patch.object(cc, "trim_oldest_files") as trim:
                write_classification_attempt(folder, frame, "evt", 2.0, "x", 0.5)
            trim.assert_called_once_with(folder, 100)


if __name__ == "__main__":
    unittest.main()
