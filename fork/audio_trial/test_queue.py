"""Tests for queue safety, resource gates, and failure-based escalation."""

import tempfile
import unittest
from pathlib import Path

from queue_store import Queue, health_reason, retry_reasons


def event(identifier="one", camera="doorbell", start=950, end=970, audio=None):
    """Build a closed review segment without model or server dependencies."""
    return {
        "id": identifier,
        "camera": camera,
        "start_time": start,
        "end_time": end,
        "data": {"audio": ["speech"] if audio is None else audio, "objects": []},
    }


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "queue.sqlite")
        self.queue = Queue(self.path)

    def tearDown(self):
        self.queue.db.close()
        self.temp.cleanup()

    def test_polls_do_not_duplicate_completed_results(self):
        self.queue.enqueue([event()], 1000, ["doorbell"])
        job = self.queue.claim(1000)
        self.queue.finish(job, 1001, {"transcript": "hello"})
        self.queue.enqueue([event()], 1002, ["doorbell"])
        self.assertIsNone(self.queue.claim(1002))
        self.assertEqual(len(self.queue.recent()), 1)

    def test_restart_recovers_running_work(self):
        self.queue.enqueue([event()], 1000, ["doorbell"])
        self.queue.claim(1000)
        self.queue.db.close()
        self.queue = Queue(self.path)
        self.assertIsNotNone(self.queue.claim(1001))

    def test_limits_camera_scope_and_ignores_unsettled_or_irrelevant_events(self):
        events = [
            event(camera="street"),
            event(end=None),
            event(end=995),
            event(audio=[]),
        ]
        self.queue.enqueue(events, 1000, ["doorbell"])
        self.assertIsNone(self.queue.claim(1000))

    def test_overload_keeps_doorbell_priority_and_bounded_work(self):
        events = [event(str(i), camera="street") for i in range(30)] + [event()]
        self.queue.enqueue(events, 1000, ["doorbell", "street"])
        self.assertEqual(self.queue.claim(1000)["camera"], "doorbell")
        self.assertEqual(sum(j["state"] == "pending" for j in self.queue.recent()), 19)

    def test_failure_retries_once_and_old_work_expires(self):
        self.queue.enqueue([event()], 1000, ["doorbell"])
        for _ in range(2):
            job = self.queue.claim(1000)
            self.queue.fail(job, 1000, "test")
        self.assertIsNone(self.queue.claim(1000))
        self.assertEqual(self.queue.recent()[0]["state"], "failed")
        self.queue.enqueue([event("two")], 1000, ["doorbell"])
        self.queue.enqueue([], 1600, ["doorbell"])
        self.assertIsNone(self.queue.claim(1600))

    def test_long_events_have_stable_ids_and_bounded_clip_lengths(self):
        review = event(start=100, end=970)
        self.queue.enqueue([review], 1000, ["doorbell"])
        before = {j["id"]: j["start"] for j in self.queue.recent()}
        self.queue.enqueue([review], 1010, ["doorbell"])
        for job in self.queue.recent():
            self.assertLessEqual(job["end"] - job["start"], 30)
            if job["id"] in before:
                self.assertEqual(job["start"], before[job["id"]])


class PolicyTests(unittest.TestCase):
    def test_load_and_memory_gates(self):
        stats = {
            "detectors": {"rocm": {"inference_speed": 15}},
            "cameras": {"doorbell": {"skipped_fps": 0}},
        }
        self.assertEqual(health_reason(stats, 6 * 1024**3), "")
        self.assertTrue(health_reason(stats, 6 * 1024**3, large=True))
        self.assertTrue(health_reason({}, 100 * 1024**3))
        stats["cameras"]["doorbell"]["skipped_fps"] = 1
        self.assertTrue(health_reason(stats, 100 * 1024**3))
        stats["cameras"]["doorbell"]["skipped_fps"] = 0
        stats["detectors"]["rocm"]["inference_speed"] = 31
        self.assertTrue(health_reason(stats, 100 * 1024**3))

    def test_no_retry_for_noise_or_an_untrusted_confidence_number(self):
        self.assertFalse(retry_reasons({"speech_seconds": 0, "transcript": ""}))
        self.assertFalse(retry_reasons({"transcript": "hello", "confidence": 0.01}))
        self.assertTrue(retry_reasons({"speech_seconds": 3, "transcript": ""}))
        self.assertTrue(retry_reasons({"transcript": "thank you " * 12}))


if __name__ == "__main__":
    unittest.main()
