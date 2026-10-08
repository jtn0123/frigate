"""SV14: preserve unverified footage within explicit disk and age limits."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frigate.fork.recording_quarantine import RecordingQuarantine


class TestRecordingQuarantine(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = RecordingQuarantine(self.root / "quarantine")

    def preserve(self, value=b"footage", now=100):
        source = self.root / "saved.mp4.tmp"
        source.write_bytes(value)
        return self.store.preserve(source, "front", "main", "video_timing", now)

    def test_preserves_exact_saved_bytes_without_registration_or_cache_growth(self):
        saved = self.preserve()
        self.assertEqual(saved.read_bytes(), b"footage")
        self.assertFalse((self.root / "saved.mp4.tmp").exists())

    def test_count_bound_removes_oldest_even_for_zero_length_files(self):
        with patch("frigate.fork.recording_quarantine.MAX_QUARANTINE_FILES", 2):
            first = self.preserve(b"", 100)
            second = self.preserve(b"", 101)
            third = self.preserve(b"", 102)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(third.exists())
        self.assertEqual(len(list(self.store.directory.iterdir())), 2)

    def test_byte_bound_preserves_newest_evidence(self):
        with patch("frigate.fork.recording_quarantine.MAX_QUARANTINE_BYTES", 10):
            first = self.preserve(b"123456", 100)
            second = self.preserve(b"123456", 101)
        self.assertFalse(first.exists())
        self.assertEqual(second.read_bytes(), b"123456")

    def test_age_prune_runs_without_additional_failures(self):
        saved = self.preserve(now=100)
        with patch("frigate.fork.recording_quarantine.QUARANTINE_SECONDS", 60):
            self.store.prune(161)
        self.assertFalse(saved.exists())

    def test_oversized_input_is_left_intact_for_existing_retry_policy(self):
        with patch("frigate.fork.recording_quarantine.MAX_QUARANTINE_BYTES", 2):
            with self.assertRaises(OSError):
                self.preserve(b"123")
        self.assertEqual((self.root / "saved.mp4.tmp").read_bytes(), b"123")

    def test_unrelated_files_and_symlink_targets_are_never_pruned(self):
        self.preserve()
        unrelated = self.store.directory / "owner-note.txt"
        unrelated.write_text("keep")
        target = self.root / "outside.mp4"
        target.write_bytes(b"outside")
        (self.store.directory / "integrity-link.mp4").symlink_to(target)
        self.store.prune(1000000)
        self.assertEqual(target.read_bytes(), b"outside")
        self.assertEqual(unrelated.read_text(), "keep")

    def test_bounded_scan_fails_without_moving_the_new_file(self):
        self.preserve()
        with patch("frigate.fork.recording_quarantine.MAX_SCAN_ENTRIES", 0):
            with self.assertRaises(OSError):
                self.preserve(now=200)
        self.assertTrue((self.root / "saved.mp4.tmp").exists())

    def test_non_regular_input_is_not_followed(self):
        target = self.root / "target.mp4"
        target.write_bytes(b"keep")
        source = self.root / "source.mp4"
        source.symlink_to(target)
        with self.assertRaises(OSError):
            self.store.preserve(source, "front", "main", "video_timing", 100)
        self.assertEqual(target.read_bytes(), b"keep")

    def test_repeated_prune_within_interval_avoids_another_scan(self):
        self.preserve()
        with patch.object(self.store, "_entries") as entries:
            self.store.prune(101)
        entries.assert_not_called()
