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

    def _train_image(self, name: str) -> None:
        folder = os.path.join(self.clips, "vehicle_type", "train")
        os.makedirs(folder, exist_ok=True)
        cv2.imwrite(os.path.join(folder, name), np.zeros((8, 8, 3), dtype=np.uint8))

    def _reviewed(self, category: str, count: int, auto: bool = False) -> None:
        for _ in range(count):
            suggest.record_confirmation(
                self.clips,
                "vehicle_type",
                {
                    "suggested_category": category,
                    "category": category,
                    "accepted": True,
                    "auto": auto,
                },
            )

    def _process(self, worker, description: str = "A white SUV is parked."):
        return asyncio.run(
            worker.process(
                {
                    "id": "evt-1",
                    "camera": "front_door",
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

    def test_queue_full_is_reported_not_raised(self):
        with patch.object(prefetch, "QUEUE_SIZE", 1):
            worker = self.worker()
        job = {"id": "x", "camera": "c", "label": "car", "description": "d"}
        self.assertTrue(worker.submit(job))
        self.assertFalse(worker.submit(job))


if __name__ == "__main__":
    unittest.main()
