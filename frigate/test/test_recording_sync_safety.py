"""Regression coverage for recording cleanup while new segments are arriving."""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from peewee import SqliteDatabase

from frigate.models import Recordings, RecordingsToDelete
from frigate.util.media import sync_recordings


class TestRecordingSyncSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = SqliteDatabase(":memory:")
        self.binding = self.database.bind_ctx([Recordings, RecordingsToDelete])
        self.binding.__enter__()
        self.addCleanup(self.binding.__exit__, None, None, None)
        self.database.create_tables([Recordings])
        self.addCleanup(self.database.close)
        self.patch = patch("frigate.util.media.RECORD_DIR", str(self.root))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        for index in range(10):
            self.add_recording(index)

    def add_recording(self, index, exists=True):
        path = self.root / f"{index:05}.mp4"
        if exists:
            path.write_bytes(b"recording")
        Recordings.create(
            id=f"{index:05}",
            camera="front",
            path=str(path),
            start_time=index,
            end_time=index + 10,
            duration=10,
        )
        return path

    def test_cleanup_preserves_a_segment_not_yet_registered_in_database(self):
        pending = self.root / "new-segment.mp4"
        pending.write_bytes(b"still being saved")
        result = sync_recordings()
        self.assertFalse(result.aborted)
        self.assertIsNone(result.error)
        self.assertTrue(pending.exists())
        self.assertEqual(result.orphans_deleted, 0)

    def test_force_does_not_override_protection_of_new_segments(self):
        pending = self.root / "new-segment.mp4"
        pending.write_bytes(b"still being saved")
        sync_recordings(force=True)
        self.assertTrue(pending.exists())

    def test_old_unreferenced_segment_is_still_removed(self):
        orphan = self.root / "old-orphan.mp4"
        orphan.write_bytes(b"orphan")
        old = time.time() - 86400
        os.utime(orphan, (old, old))
        result = sync_recordings()
        self.assertFalse(orphan.exists())
        self.assertEqual(result.orphans_deleted, 1)

    def test_dry_run_preserves_old_orphan(self):
        orphan = self.root / "old-orphan.mp4"
        orphan.write_bytes(b"orphan")
        old = time.time() - 86400
        os.utime(orphan, (old, old))
        result = sync_recordings(dry_run=True)
        self.assertTrue(orphan.exists())
        self.assertEqual(result.orphans_found, 1)
        self.assertEqual(result.orphans_deleted, 0)

    def test_cleanup_inspects_final_database_page(self):
        for index in range(10, 2000):
            self.add_recording(index)
        missing = self.add_recording(2000, exists=False)
        result = sync_recordings(dry_run=True)
        self.assertEqual(result.orphan_db_paths, [str(missing)])

    def test_file_registered_after_scan_is_not_deleted(self):
        orphan = self.root / "arriving.mp4"
        orphan.write_bytes(b"complete recording")
        old = time.time() - 86400
        os.utime(orphan, (old, old))

        def register_before_deletion(message):
            if "orphaned recordings files" in message:
                Recordings.create(
                    id="arriving",
                    camera="front",
                    path=str(orphan),
                    start_time=0,
                    end_time=10,
                    duration=10,
                )

        with patch(
            "frigate.util.media.logger.info", side_effect=register_before_deletion
        ):
            result = sync_recordings()
        self.assertTrue(orphan.exists())
        self.assertEqual(result.orphans_deleted, 0)

    def test_file_modified_after_scan_is_not_deleted(self):
        orphan = self.root / "resumed.mp4"
        orphan.write_bytes(b"recording")
        old = time.time() - 86400
        os.utime(orphan, (old, old))

        def resume_before_deletion(message):
            if "orphaned recordings files" in message:
                orphan.write_bytes(b"writer resumed")

        with patch(
            "frigate.util.media.logger.info", side_effect=resume_before_deletion
        ):
            result = sync_recordings()
        self.assertTrue(orphan.exists())
        self.assertEqual(result.orphans_deleted, 0)
