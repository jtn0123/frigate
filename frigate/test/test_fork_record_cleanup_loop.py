"""Tests that the recording cleanup loop survives a failed pass."""

import unittest
from unittest.mock import MagicMock, patch

from frigate.record.cleanup import RecordingCleanup


class TestRecordingCleanupLoop(unittest.TestCase):
    def _build_cleanup(self) -> RecordingCleanup:
        config = MagicMock()
        config.safe_mode = False
        config.record.expire_interval = 1
        stop_event = MagicMock()
        # two passes, then stop
        stop_event.wait.side_effect = [False, False, True]
        cleanup = RecordingCleanup(config, stop_event)
        cleanup.clean_tmp_previews = MagicMock()
        cleanup.clean_tmp_clips = MagicMock()
        cleanup.expire_recordings = MagicMock(return_value=set())
        cleanup.truncate_wal = MagicMock()
        return cleanup

    def test_failed_pass_does_not_stop_later_passes(self):
        # Regression: an exception in one pass (a locked database while
        # expiring, an unreadable cache file) ended the thread, so
        # recordings were never expired again and the disk filled up.
        cleanup = self._build_cleanup()
        cleanup.expire_recordings.side_effect = [OSError("disk error"), set()]

        with (
            patch("frigate.record.cleanup.remove_empty_directories"),
            patch("frigate.record.cleanup.logger.exception") as log_exception,
        ):
            cleanup.run()

        self.assertEqual(cleanup.expire_recordings.call_count, 2)
        self.assertEqual(cleanup.truncate_wal.call_count, 1)
        log_exception.assert_called_once()


if __name__ == "__main__":
    unittest.main()
