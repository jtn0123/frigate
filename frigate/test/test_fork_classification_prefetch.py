"""Fork (I43): tests for drafting a class as each description arrives."""

import asyncio
import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from frigate.config import FrigateConfig
from frigate.fork import classification_prefetch as prefetch
from frigate.test.test_fork_classification_suggestions import choice

CLASSES = ["sedan", "suv", "none"]


def build_config(root: str, jev: bool = True, background: bool = True) -> FrigateConfig:
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
                "suggestions": {"jev": {"enabled": jev, "background": background}},
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

    def test_queue_full_is_reported_not_raised(self):
        with patch.object(prefetch, "QUEUE_SIZE", 1):
            worker = self.worker()
        job = {"id": "x", "camera": "c", "label": "car", "description": "d"}
        self.assertTrue(worker.submit(job))
        self.assertFalse(worker.submit(job))


if __name__ == "__main__":
    unittest.main()
