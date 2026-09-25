"""Fork (I43): tests for drafting a class as each description arrives."""

import asyncio
import json
import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from frigate.config import FrigateConfig
from frigate.fork import classification_prefetch as prefetch
from frigate.fork import classification_suggestions as suggest
from frigate.test.test_fork_classification_suggestions import choice

CLASSES = ["sedan", "suv", "none"]


def build_config(
    root: str,
    jev: bool = True,
    background: bool = True,
    auto_file: dict | None = None,
) -> FrigateConfig:
    return FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "database": {"path": os.path.join(root, "frigate.db")},
            "cameras": {
                "front_door": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {"height": 1080, "width": 1920, "fps": 5},
                }
            },
            "classification": {
                "custom": {
                    "vehicle_type": {"object_config": {"objects": ["car"]}},
                    "dog_breed": {"object_config": {"objects": ["dog"]}},
                    "empty_model": {"object_config": {"objects": ["car"]}},
                },
                "suggestions": {
                    "jev": {"enabled": jev, "background": background},
                    "auto_file": auto_file or {},
                },
            },
        }
    )


class TestSuggestionPrefetch(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.clips = os.path.join(self.root, "clips")
        for name in CLASSES:
            os.makedirs(os.path.join(self.clips, "vehicle_type", "dataset", name))
        os.makedirs(os.path.join(self.clips, "empty_model", "dataset"))
        self.asked: list[dict] = []
        # No database in these tests: the model check sees no event unless a
        # test says otherwise.
        no_event = patch.object(
            prefetch.SuggestionPrefetch, "load_event", return_value=None
        )
        no_event.start()
        self.addCleanup(no_event.stop)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def worker(self, **kwargs) -> prefetch.SuggestionPrefetch:
        def factory(_session):
            async def ask(request):
                self.asked.append(request)
                return choice("suv", CLASSES)

            return ask

        return prefetch.SuggestionPrefetch(
            build_config(self.root, **kwargs), self.clips, factory
        )

    def test_only_models_for_the_label_with_classes_apply(self):
        worker = self.worker()
        self.assertEqual(worker.models_for("car"), {"vehicle_type": sorted(CLASSES)})
        self.assertEqual(worker.models_for("dog"), {})
        self.assertEqual(worker.models_for("person"), {})

    def test_process_drafts_and_caches_so_the_grid_finds_it(self):
        worker = self.worker()
        job = {
            "id": "evt-1",
            "camera": "front_door",
            "label": "car",
            "description": "A white SUV is parked.",
        }
        first = asyncio.run(worker.process(job))
        self.assertEqual(first["vehicle_type"]["suggestion"]["category"], "suv")
        self.assertEqual(first["vehicle_type"]["jev_status"], "answered")
        self.assertEqual(len(self.asked), 1)
        self.assertEqual(worker.budget.used(), 1)

        second = asyncio.run(worker.process({**job, "id": "evt-2"}))
        self.assertEqual(second["vehicle_type"]["jev"]["category"], "suv")
        self.assertEqual(len(self.asked), 1, "the cached answer is reused")

        self.assertEqual(asyncio.run(worker.process({**job, "label": "dog"})), {})

    def test_run_survives_a_failing_job(self):
        worker = self.worker()
        with patch.object(worker, "process", side_effect=RuntimeError("boom")):
            worker.submit(
                {"id": "x", "camera": "c", "label": "car", "description": "d"}
            )
            worker.stop()
            worker.run()

    def test_prefetch_for_event_gates_and_queues(self):
        event = SimpleNamespace(
            id="evt-9",
            camera="front_door",
            label="car",
            data={"description": "A sedan."},
        )
        no_key = patch.dict(
            os.environ, {"FRIGATE_JEV_API_KEY": "", "OPENROUTER_API_KEY": ""}
        )
        with no_key:
            self.assertFalse(
                prefetch.prefetch_for_event(build_config(self.root), event)
            )
        with patch.dict(os.environ, {"FRIGATE_JEV_API_KEY": "k"}):
            self.assertFalse(
                prefetch.prefetch_for_event(build_config(self.root, jev=False), event)
            )
            self.assertFalse(
                prefetch.prefetch_for_event(
                    build_config(self.root, background=False), event
                )
            )
            blank = SimpleNamespace(**{**vars(event), "data": {"description": "  "}})
            self.assertFalse(
                prefetch.prefetch_for_event(build_config(self.root), blank)
            )
            with (
                patch.object(prefetch.SuggestionPrefetch, "start"),
                patch.object(prefetch, "_worker", None),
            ):
                self.assertTrue(
                    prefetch.prefetch_for_event(build_config(self.root), event)
                )
                worker = prefetch._worker
                assert worker is not None
                self.assertEqual(
                    worker.queue.get_nowait(),
                    {
                        "id": "evt-9",
                        "camera": "front_door",
                        "label": "car",
                        "description": "A sedan.",
                    },
                )

    def _train_image(self, name: str, size: int = 120) -> None:
        folder = os.path.join(self.clips, "vehicle_type", "train")
        os.makedirs(folder, exist_ok=True)
        cv2.imwrite(
            os.path.join(folder, name), np.zeros((size, size, 3), dtype=np.uint8)
        )

    def _dataset_image(self, category: str, name: str) -> None:
        folder = os.path.join(self.clips, "vehicle_type", "dataset", category)
        os.makedirs(folder, exist_ok=True)
        cv2.imwrite(os.path.join(folder, name), np.zeros((8, 8, 3), dtype=np.uint8))

    def _reviewed(
        self,
        category: str,
        count: int,
        auto: bool = False,
        bulk: bool = False,
        event_id: str | None = None,
    ) -> None:
        for _ in range(count):
            suggest.record_confirmation(
                self.clips,
                "vehicle_type",
                {
                    "event_id": event_id,
                    "suggested_category": category,
                    "category": category,
                    "accepted": True,
                    "auto": auto,
                    "bulk": bulk,
                },
            )

    def _process(
        self,
        worker,
        description: str = "A white SUV is parked.",
        event_id: str = "evt-1",
        camera: str = "front_door",
    ):
        return asyncio.run(
            worker.process(
                {
                    "id": event_id,
                    "camera": camera,
                    "label": "car",
                    "description": description,
                }
            )
        )

    def test_auto_file_waits_for_agreement_and_a_trusted_class(self):
        auto = {"enabled": True, "min_kept_rate": 0.9, "min_drafts": 2}
        self._train_image("evt-1-1.0-unknown-0.0.webp")
        self._train_image("evt-1-2.0-unknown-0.0.webp")
        self._train_image("evt-2-1.0-unknown-0.0.webp")
        train = os.path.join(self.clips, "vehicle_type", "train")
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "suv")

        self._process(self.worker())
        self.assertEqual(len(os.listdir(train)), 3, "off by default")

        worker = self.worker(auto_file=auto)
        self._process(worker)
        self.assertEqual(len(os.listdir(train)), 3, "no reviewed drafts yet")

        self._reviewed("suv", 3, auto=True)
        self._process(worker)
        self.assertEqual(len(os.listdir(train)), 3, "auto-filed ones do not count")

        self._reviewed("suv", 2)
        self._process(worker, "A white sedan is parked.")
        self.assertEqual(len(os.listdir(train)), 3, "text and Jev disagree")

        self._process(worker)
        self.assertEqual(sorted(os.listdir(train)), ["evt-2-1.0-unknown-0.0.webp"])
        self.assertEqual(len(os.listdir(dataset)), 2)
        entries = suggest.read_provenance(self.clips, "vehicle_type")
        last = entries[-1]
        self.assertTrue(last["auto"])
        self.assertEqual(last["event_id"], "evt-1")
        self.assertEqual(last["source"], "jev")
        self.assertEqual(len(last["files"]), 2)
        self.assertEqual(
            last["description_sha256"],
            suggest.description_sha256("A white SUV is parked."),
        )
        report = suggest.summarize_provenance(entries)
        self.assertEqual(report["auto_filed"], 4)
        self.assertEqual(report["total"], 2, "auto-filed stays out of the rate")
        self.assertEqual(report["classes"]["suv"]["auto_filed"], 4)

    def test_bulk_and_undone_accepts_do_not_earn_auto_filing(self):
        auto = {"enabled": True, "min_kept_rate": 0.9, "min_drafts": 2}
        self._train_image("evt-1-1.0-unknown-0.0.webp")
        train = os.path.join(self.clips, "vehicle_type", "train")
        worker = self.worker(auto_file=auto)

        self._reviewed("suv", 5, bulk=True)
        self._process(worker)
        self.assertEqual(len(os.listdir(train)), 1, "bulk accepts are not reviews")

        self._reviewed("suv", 1)
        self._reviewed("suv", 1, event_id="evt-7")
        suggest.record_confirmation(
            self.clips,
            "vehicle_type",
            {"event_id": "evt-7", "category": "suv", "undo": True, "files": []},
        )
        self._process(worker)
        self.assertEqual(len(os.listdir(train)), 1, "the undone accept left min_drafts")

        self._reviewed("suv", 1, event_id="evt-8")
        self._process(worker)
        self.assertEqual(os.listdir(train), [], "two standing reviews earn it")
        last = suggest.read_provenance(self.clips, "vehicle_type")[-1]
        self.assertTrue(last["auto"])
        self.assertEqual(last["train_files"], ["evt-1-1.0-unknown-0.0.webp"])

    def test_auto_file_leaves_a_group_a_person_filed_first(self):
        auto = {"enabled": True, "min_kept_rate": 0.9, "min_drafts": 1}
        self._reviewed("suv", 1)
        self._train_image("evt-1-1.0-unknown-0.0.webp")
        with patch.object(
            suggest, "file_train_images", side_effect=suggest.AlreadyFiledError("x")
        ):
            self._process(self.worker(auto_file=auto))
        self.assertEqual(len(suggest.read_provenance(self.clips, "vehicle_type")), 1)

    def test_auto_file_waits_for_the_camera_cooldown_and_daily_limit(self):
        auto = {"enabled": True, "min_kept_rate": 0.9, "min_drafts": 1}
        self._reviewed("suv", 2)
        for event in ("evt-1", "evt-2", "evt-3", "evt-4"):
            self._train_image(f"{event}-1.0-unknown-0.0.webp")
        train = os.path.join(self.clips, "vehicle_type", "train")

        worker = self.worker(auto_file=auto)
        self._process(worker, event_id="evt-1")
        self.assertEqual(len(os.listdir(train)), 3)
        self._process(worker, event_id="evt-2")
        self.assertEqual(len(os.listdir(train)), 3, "same camera, inside the cooldown")
        self._process(worker, event_id="evt-2", camera="side")
        self.assertEqual(len(os.listdir(train)), 2, "another camera is fine")

        worker = self.worker(
            auto_file={**auto, "camera_cooldown": 0, "per_camera_daily_limit": 1}
        )
        self._process(worker, event_id="evt-3")
        self.assertEqual(len(os.listdir(train)), 2, "front_door hit its daily limit")
        self._process(worker, event_id="evt-3", camera="side")
        self.assertEqual(len(os.listdir(train)), 2, "so did side")
        worker = self.worker(
            auto_file={**auto, "camera_cooldown": 0, "per_camera_daily_limit": 5}
        )
        self._process(worker, event_id="evt-3")
        self._process(worker, event_id="evt-4")
        self.assertEqual(len(os.listdir(train)), 0)

    def test_auto_file_skips_sure_and_tiny_images_and_a_lopsided_class(self):
        auto = {
            "enabled": True,
            "min_kept_rate": 0.9,
            "min_drafts": 1,
            "camera_cooldown": 0,
        }
        self._reviewed("suv", 2)
        self._train_image("evt-1-1.0-suv-0.95.webp")
        self._train_image("evt-1-2.0-suv-0.5.webp")
        self._train_image("evt-1-3.0-unknown-0.0.webp", size=60)
        train = os.path.join(self.clips, "vehicle_type", "train")
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "suv")

        worker = self.worker(auto_file=auto)
        self._process(worker)
        self.assertEqual(
            sorted(os.listdir(train)),
            ["evt-1-1.0-suv-0.95.webp", "evt-1-3.0-unknown-0.0.webp"],
            "only the image the model was unsure about is worth filing",
        )
        self.assertEqual(len(os.listdir(dataset)), 1)

        self._train_image("evt-2-1.0-unknown-0.0.webp")
        for i in range(3):
            self._dataset_image("suv", f"suv-{i}.png")
        self._dataset_image("sedan", "sedan-0.png")
        self._process(worker, event_id="evt-2")
        self.assertEqual(len(os.listdir(dataset)), 4, "5 to 1 would be lopsided")
        self._dataset_image("sedan", "sedan-1.png")
        self._process(worker, event_id="evt-2")
        self.assertEqual(len(os.listdir(dataset)), 5, "5 to 2 is within the ratio")

    def test_kept_rate_reads_only_human_confirmations(self):
        self._reviewed("suv", 2)
        self._reviewed("suv", 5, auto=True)
        suggest.record_confirmation(
            self.clips,
            "vehicle_type",
            {"suggested_category": "SUV", "category": "sedan", "accepted": False},
        )
        entries = suggest.read_provenance(self.clips, "vehicle_type")
        self.assertEqual(suggest.kept_rate(entries, "suv"), (2 / 3, 3))
        self.assertEqual(suggest.kept_rate(entries, "van"), (None, 0))
        self.assertEqual(
            suggest.train_files_for_event(self.clips, "vehicle_type", "evt-1"), []
        )
        self._train_image("evt-1-2.0-unknown-0.0.webp")
        self._train_image("evt-1-1.0-unknown-0.0.webp")
        self._train_image("evt-10-1.0-unknown-0.0.webp")
        self.assertEqual(
            suggest.train_files_for_event(self.clips, "vehicle_type", "evt-1"),
            ["evt-1-1.0-unknown-0.0.webp", "evt-1-2.0-unknown-0.0.webp"],
        )
        self.assertIsNone(json.loads(json.dumps(suggest.sure_draft(None, None))))

    def test_check_model_records_agreement_with_the_trained_model(self):
        worker = self.worker()
        with patch.object(worker, "load_event", return_value=None):
            self._process(worker)
        self.assertEqual(suggest.read_model_checks(self.clips, "vehicle_type"), [])

        with patch.object(worker, "load_event", return_value={"sub_label": "sedan"}):
            self._process(worker)
        with patch.object(worker, "load_event", return_value={"sub_label": "suv"}):
            self._process(worker)
        with patch.object(worker, "load_event", return_value={"sub_label": "Bob"}):
            self._process(worker)
        checks = suggest.read_model_checks(self.clips, "vehicle_type")
        self.assertEqual([c["agree"] for c in checks], [False, True])
        self.assertEqual(checks[0]["model_said"], "sedan")
        self.assertEqual(checks[0]["draft"], "suv")
        self.assertEqual(checks[0]["event_id"], "evt-1")
        self.assertNotIn("white SUV", json.dumps(checks), "never the text itself")

    def test_queue_full_is_reported_not_raised(self):
        with patch.object(prefetch, "QUEUE_SIZE", 1):
            worker = self.worker()
        job = {"id": "x", "camera": "c", "label": "car", "description": "d"}
        self.assertTrue(worker.submit(job))
        self.assertFalse(worker.submit(job))


if __name__ == "__main__":
    unittest.main()
