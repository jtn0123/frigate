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
        self.telemetry_patch = patch.dict(
            "os.environ", {"TELEMETRY_DIR": str(self.root / "telemetry")}
        )
        self.telemetry_patch.start()
        self.addCleanup(self.telemetry_patch.stop)
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

    def test_stage_cleanup_and_log_failures_do_not_discard_inference(self):
        output = self.root / "result.json"
        original_open = Path.open

        def open_file(path, *args, **kwargs):
            if path.name == "inference.log":
                raise PermissionError("unwritable log")
            return original_open(path, *args, **kwargs)

        def launch(*args, **kwargs):
            output.write_text(json.dumps({"transcript": "kept"}))
            return Mock(poll=Mock(return_value=0), returncode=0)

        with (
            patch.object(
                worker, "STAGE_FILE", Mock(unlink=Mock(side_effect=OSError()))
            ),
            patch.object(Path, "open", open_file),
            patch.object(worker.subprocess, "Popen", side_effect=launch),
            patch.object(worker, "METRICS", None),
        ):
            self.assertEqual(
                worker.infer(self.root / "audio.wav", output, "medium"),
                {"transcript": "kept"},
            )

    def test_optional_operator_report_failure_does_not_fail_job(self):
        with (
            patch.object(worker, "atomic_json", side_effect=OSError("disk full")),
            patch.object(worker, "METRICS", None),
        ):
            worker.write_status(self.queue, "processing")
        self.assertEqual(self.queue.recent()[0]["state"], "running")

    def test_ready_backlog_drains_without_wait_and_polls_once(self):
        queue = Mock()
        queue.claim.side_effect = [{"id": "one"}, {"id": "two"}, None]
        stop = Mock()
        stop.is_set.side_effect = [False, False, False, True]
        with (
            patch.object(worker, "Queue", return_value=queue),
            patch.object(worker, "STOP", stop),
            patch.object(worker, "health", return_value="") as health,
            patch.object(worker, "read_json", return_value=[]) as read,
            patch.object(worker, "write_status"),
            patch.object(worker, "process_job") as process,
            patch.object(worker.signal, "signal"),
        ):
            worker.main()
        self.assertEqual(process.call_count, 2)
        self.assertEqual(health.call_count, 3)
        read.assert_called_once()
        stop.wait.assert_called_once_with(10)

    def test_pressure_keeps_cooldown_and_never_claims(self):
        queue = Mock()
        stop = Mock()
        stop.is_set.side_effect = [False, True]
        with (
            patch.object(worker, "Queue", return_value=queue),
            patch.object(worker, "STOP", stop),
            patch.object(worker, "health", return_value="camera pressure"),
            patch.object(worker, "read_json", return_value=[]),
            patch.object(worker, "write_status"),
            patch.object(worker.signal, "signal"),
        ):
            worker.main()
        queue.claim.assert_not_called()
        stop.wait.assert_called_once_with(10)

    def test_publication_retries_after_mount_recovers(self):
        with patch("queue_store.publish", side_effect=OSError("unavailable")):
            self.queue.finish(self.job, 1001, {"transcript": "preserved"})
        self.assertEqual(
            self.queue.db.execute("SELECT COUNT(*) FROM publications").fetchone()[0], 1
        )
        self.queue.flush_publications()
        files = list((self.root / "telemetry/results").glob("*.json"))
        self.assertEqual(len(files), 1)
        self.assertIn("preserved", files[0].read_text())

    def test_inflight_medium_checkpoint_recovers_as_second_opinion(self):
        self.queue.checkpoint(self.job, 1001, {"transcript": "preserved"})
        recovered = Queue(str(self.root / "queue.sqlite"))
        self.addCleanup(recovered.db.close)
        row = recovered.claim(1100)
        self.assertEqual(row["state"], "second_opinion")
        self.assertEqual(json.loads(row["result"])["transcript"], "preserved")

    def test_deferred_second_opinion_expires_without_losing_medium(self):
        self.queue.defer(self.job, 1001, {"transcript": "preserved"})
        self.assertIsNone(self.queue.claim(5000))
        result = json.loads(self.queue.recent()[0]["result"])
        self.assertEqual(result["transcript"], "preserved")
        self.assertIn("expired", result["large_status"])

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
