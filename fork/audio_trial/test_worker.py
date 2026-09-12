"""Exercise service boundaries without models, cameras, or network access."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import worker
from queue_store import Queue


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_patch = patch.object(worker, "STATE", self.root)
        self.state_patch.start()
        self.queue = Queue(str(self.root / "queue.sqlite"))
        self.queue.enqueue(
            [
                {
                    "id": "test",
                    "camera": "doorbell",
                    "start_time": 950,
                    "end_time": 970,
                    "data": {"audio": ["speech"]},
                }
            ],
            1000,
            ["doorbell"],
        )
        self.job = self.queue.claim(1000)

    def tearDown(self):
        self.queue.db.close()
        self.state_patch.stop()
        self.temp.cleanup()

    @patch.object(worker, "download_audio", return_value=Path("audio.wav"))
    @patch.object(worker, "health", return_value="")
    @patch.object(worker, "infer")
    def test_large_failure_preserves_medium_and_consumes_retry_budget(self, infer, *_):
        infer.side_effect = [
            {"speech_seconds": 3, "transcript": ""},
            RuntimeError("test"),
        ]
        worker.process_job(self.queue, self.job)
        row = self.queue.recent()[0]
        self.assertEqual(row["state"], "done")
        result = json.loads(row["result"])
        self.assertIn("retry failed", result["large_status"])
        self.assertEqual(
            len(json.loads((self.root / "large-budget.json").read_text())), 1
        )

    @patch.object(worker, "download_audio", return_value=Path("audio.wav"))
    @patch.object(worker, "health", return_value="insufficient spare memory")
    @patch.object(worker, "infer", return_value={"speech_seconds": 3, "transcript": ""})
    def test_memory_pressure_prevents_large_model_load(self, infer, *_):
        worker.process_job(self.queue, self.job)
        self.assertEqual(infer.call_count, 1)
        self.assertIn(
            "deferred", json.loads(self.queue.recent()[0]["result"])["large_status"]
        )

    @patch.object(worker, "download_audio", return_value=Path("audio.wav"))
    @patch.object(worker, "health", return_value="")
    @patch.object(worker, "infer", return_value={"speech_seconds": 3, "transcript": ""})
    def test_retry_budget_survives_calls(self, infer, *_):
        (self.root / "large-budget.json").write_text(
            json.dumps([worker.time.time()] * 2)
        )
        worker.process_job(self.queue, self.job)
        self.assertEqual(infer.call_count, 1)
        self.assertEqual(
            json.loads(self.queue.recent()[0]["result"])["large_status"],
            "hourly retry limit",
        )

    @patch.object(worker, "memory_available", return_value=8 * 1024**3)
    @patch.object(worker, "read_json", return_value={})
    @patch.object(worker.STOP, "wait", return_value=False)
    @patch.object(worker.subprocess, "Popen")
    def test_unavailable_camera_health_terminates_running_inference(self, popen, *_):
        process = Mock()
        process.poll.return_value = None
        popen.return_value = process
        with self.assertRaisesRegex(RuntimeError, "priority"):
            worker.infer(self.root / "audio.wav", self.root / "output.json", "medium")
        process.terminate.assert_called_once()
        process.wait.assert_called_once()

    def test_inner_unlimited_cgroup_uses_lxc_memory_limit(self):
        values = {
            "/host-cgroup/memory.max": "max",
            "/host-cgroup/memory.current": str(15 * 1024**3),
            "/host-cgroup/memory.stat": f"inactive_file {7 * 1024**3}\n",
            "/host-meminfo": "MemTotal: 7340032 kB\nMemAvailable: 7340032 kB\n",
        }
        with (
            patch.object(Path, "read_text", lambda path: values[str(path)]),
            patch.dict(
                worker.os.environ, {"PARENT_MEMORY_LIMIT_BYTES": str(16 * 1024**3)}
            ),
        ):
            self.assertEqual(worker.memory_available(), int(7.5 * 1024**3))


if __name__ == "__main__":
    unittest.main()
