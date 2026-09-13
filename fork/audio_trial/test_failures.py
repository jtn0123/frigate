"""Failure reports preserve actionable causes without including private input."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from failures import AudioFailure, save_failure, stage


class FailureTests(unittest.TestCase):
    def test_download_error_does_not_leak_url(self):
        with self.assertRaises(AudioFailure) as raised:
            with stage("download"):
                raise OSError("http://user:secret@camera/private")
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
                with stage("medium"):
                    raise error
            self.assertEqual(raised.exception.cause, expected)
