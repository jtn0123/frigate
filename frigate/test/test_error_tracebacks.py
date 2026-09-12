"""Recoverable failures must retain tracebacks without changing recovery."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frigate.util import camera_cleanup
from frigate.util.downloader import ModelDownloader


class TestErrorTracebacks(unittest.TestCase):
    def test_cleanup_database_errors_keep_tracebacks_and_continue(self):
        models = [
            camera_cleanup.Event,
            camera_cleanup.Timeline,
            camera_cleanup.Recordings,
            camera_cleanup.ReviewSegment,
            camera_cleanup.Previews,
            camera_cleanup.Regions,
            camera_cleanup.Trigger,
        ]
        from contextlib import ExitStack

        with ExitStack() as stack:
            for model in models:
                stack.enter_context(
                    patch.object(
                        model, "delete", side_effect=RuntimeError("database busy")
                    )
                )
            logs = stack.enter_context(self.assertLogs(camera_cleanup.logger, "ERROR"))
            counts, paths = camera_cleanup.cleanup_camera_db("front_door")

        self.assertEqual(counts, {})
        self.assertEqual(paths, [])
        self.assertEqual(len(logs.records), len(models))
        for record in logs.records:
            with self.subTest(message=record.getMessage()):
                self.assertIsNotNone(record.exc_info)
                self.assertIs(record.exc_info[0], RuntimeError)
                self.assertIn("front_door", record.getMessage())

    def test_cleanup_files_keeps_tracebacks_and_attempts_remaining_files(self):
        with (
            patch.object(camera_cleanup.os.path, "exists", return_value=True),
            patch.object(camera_cleanup.shutil, "rmtree", side_effect=OSError("busy")),
            patch.object(camera_cleanup.glob, "glob", return_value=["/test/snapshot"]),
            patch.object(
                camera_cleanup.os, "remove", side_effect=OSError("busy")
            ) as remove,
            self.assertLogs(camera_cleanup.logger, "ERROR") as logs,
        ):
            camera_cleanup.cleanup_camera_files("front_door", ["/test/export"])

        self.assertEqual(remove.call_count, 5)
        self.assertEqual(len(logs.records), 9)
        for record in logs.records:
            with self.subTest(message=record.getMessage()):
                self.assertIsNotNone(record.exc_info)
                self.assertIs(record.exc_info[0], OSError)

    def test_download_failure_keeps_traceback_and_original_exception(self):
        error = OSError("connection failed")
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("frigate.util.downloader.requests.get", side_effect=error),
            self.assertLogs("frigate.util.downloader", "ERROR") as logs,
            self.assertRaises(OSError) as raised,
        ):
            ModelDownloader.download_from_url(
                "https://example.invalid/model", str(Path(directory) / "model"), True
            )

        self.assertIs(raised.exception, error)
        self.assertIsNotNone(logs.records[0].exc_info)
        self.assertIs(logs.records[0].exc_info[1], error)
