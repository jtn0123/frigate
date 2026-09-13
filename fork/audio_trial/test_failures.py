"""Failure reports preserve actionable causes without including private input."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from failures import AudioFailure, save_failure, stage


def fail_at(name, error):
    with stage(name):
        raise error


class FailureTests(unittest.TestCase):
    def test_download_error_does_not_leak_url(self):
        error = OSError("http://user:secret@camera/private")
        with self.assertRaises(AudioFailure) as raised:
            fail_at("download", error)
        with tempfile.TemporaryDirectory() as directory:
            report = save_failure(Path(directory), raised.exception, 123)
            self.assertEqual(
                report, {"updated": 123, "stage": "download", "cause": "unavailable"}
            )
            self.assertNotIn("secret", json.dumps(report))

    def test_conversion_timeout_and_camera_priority_are_distinct(self):
        for error, expected in (
            (subprocess.TimeoutExpired("ffmpeg", 30), "timeout"),
            (RuntimeError("camera processing needs priority"), "camera_priority"),
        ):
            with self.assertRaises(AudioFailure) as raised:
                fail_at("medium", error)
            self.assertEqual(raised.exception.cause, expected)

    def test_partial_stage_failure_is_reported_without_losing_successful_output(self):
        from unittest.mock import patch

        import worker

        result = {
            "transcript": "private transcript",
            "stages": {
                "transcription": {"status": "complete"},
                "translation": {"status": "failed", "cause": "timeout"},
            },
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "STATE", Path(directory)),
        ):
            self.assertIs(worker.record_failed_stages(result), result)
            failure = json.loads((Path(directory) / "last-failure.json").read_text())
        self.assertEqual(failure["stage"], "translation")
        self.assertEqual(failure["cause"], "timeout")
        self.assertNotIn("private", json.dumps(failure))
