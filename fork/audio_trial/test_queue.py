"""Tests for queue safety, resource gates, and failure-based escalation."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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
        self.environment = patch.dict(
            "os.environ", {"TELEMETRY_DIR": str(Path(self.temp.name) / "telemetry")}
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
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

    def test_burst_reserves_a_pending_job_for_each_camera(self):
        reviews = [event(str(i), camera="doorbell") for i in range(30)]
        reviews += [event("street", camera="street")]
        self.queue.enqueue(reviews, 1000, ["doorbell", "street"])
        pending = [j for j in self.queue.recent() if j["state"] == "pending"]
        self.assertEqual(len(pending), 20)
        self.assertEqual({j["camera"] for j in pending}, {"doorbell", "street"})

    def test_waiting_camera_eventually_overtakes_new_doorbell_work(self):
        self.queue.enqueue(
            [event("street", camera="street")], 1000, ["doorbell", "street"]
        )
        self.queue.enqueue(
            [event("doorbell", start=1000, end=1030)], 1070, ["doorbell", "street"]
        )
        self.assertEqual(self.queue.claim(1070)["camera"], "street")

    def test_all_cameras_get_service_under_sustained_slow_overload(self):
        cameras = ["doorbell"] + [f"street_{i}" for i in range(8)]
        served = set()
        next_free = 1000
        with patch("queue_store.publish"):
            for now in range(1000, 2800, 15):
                reviews = (
                    [
                        event(f"{camera}-{now}", camera, now - 50, now - 30)
                        for camera in cameras
                    ]
                    if (now - 1000) % 60 == 0
                    else []
                )
                self.queue.enqueue(reviews, now, cameras)
                if now >= next_free:
                    job = self.queue.claim(now)
                    if job:
                        served.add(job["camera"])
                        self.queue.finish(job, now, {"transcript": "fixture"})
                        next_free = now + 75
        self.assertEqual(served, set(cameras))

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

    def test_upgrade_publishes_retained_legacy_results(self):
        self.queue.enqueue([event()], 1000, ["doorbell"])
        job = self.queue.claim(1000)
        self.queue.finish(job, time.time(), {"transcript": "legacy"})
        self.queue.db.execute("DROP TABLE publications")
        self.queue.db.commit()
        self.queue.db.close()
        self.queue = Queue(self.path)
        self.assertEqual(
            self.queue.db.execute("SELECT COUNT(*) FROM publications").fetchone()[0], 1
        )

    def test_expired_sibling_chunks_are_republished(self):
        self.queue.enqueue([event(start=900)], 1000, ["doorbell"])
        job = self.queue.claim(1000)
        self.queue.finish(job, 1001, {"transcript": "preserved"})
        self.queue.enqueue([], 2000, ["doorbell"])
        self.queue.flush_publications()
        path = next((Path(self.temp.name) / "telemetry/results").glob("*.json"))
        states = [chunk["state"] for chunk in json.loads(path.read_text())["chunks"]]
        self.assertIn("done", states)
        self.assertIn("expired", states)
        self.assertNotIn("pending", states)

    def test_one_bad_publication_does_not_block_other_reviews(self):
        self.queue.enqueue([event("one"), event("two")], 1000, ["doorbell"])
        for _ in range(2):
            job = self.queue.claim(1000)
            with patch("queue_store.publish", side_effect=OSError()):
                self.queue.finish(job, 1001, {"transcript": "preserved"})

        def publish(_db, job):
            if job["id"].startswith("one:"):
                raise ValueError("oversized")

        with patch("queue_store.publish", side_effect=publish) as writer:
            self.queue.flush_publications()
            self.assertEqual(writer.call_count, 2)
        remaining = self.queue.db.execute("SELECT id FROM publications").fetchall()
        self.assertEqual([row["id"] for row in remaining], ["one:0"])

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
            "service": {"last_updated": time.time()},
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

    def test_missing_stale_and_nonfinite_health_blocks_work(self):
        for reading in ({}, {"skipped_fps": float("nan")}, {"skipped_fps": None}):
            self.assertTrue(
                health_reason(
                    {
                        "service": {"last_updated": time.time()},
                        "detectors": {"cpu": {"inference_speed": 10}},
                        "cameras": {"doorbell": reading},
                    },
                    10 * 1024**3,
                )
            )
        self.assertTrue(
            health_reason(
                {
                    "service": {"last_updated": 1},
                    "detectors": {"cpu": {"inference_speed": 10}},
                    "cameras": {"doorbell": {"skipped_fps": 0}},
                },
                10 * 1024**3,
            )
        )

    def test_no_retry_for_noise_or_an_untrusted_confidence_number(self):
        self.assertFalse(retry_reasons({"speech_seconds": 0, "transcript": ""}))
        self.assertFalse(retry_reasons({"transcript": "hello", "confidence": 0.01}))
        self.assertTrue(retry_reasons({"speech_seconds": 3, "transcript": ""}))
        self.assertTrue(retry_reasons({"transcript": "thank you " * 12}))


if __name__ == "__main__":
    unittest.main()
