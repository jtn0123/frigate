"""Clip retention only changes metadata; recordings own video-file cleanup."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate.events.cleanup import EventCleanup
from frigate.models import Event


class TestClipRetentionCleanup(unittest.TestCase):
    def test_removed_camera_clip_expiry_does_not_unlink_snapshot_paths(self):
        retained = SimpleNamespace(retain=SimpleNamespace(days=1))
        config = SimpleNamespace(
            cameras={},
            record=SimpleNamespace(
                alerts=retained,
                detections=retained,
                effective_alert_days=1,
                effective_detection_days=1,
            ),
        )
        cleanup = EventCleanup(config, Mock(), Mock())
        expired = SimpleNamespace(id="expired", camera="removed")
        with (
            patch.object(Event, "select") as select,
            patch.object(Event, "update") as update,
            patch("pathlib.Path.unlink") as unlink,
        ):
            selection = select.return_value.where.return_value
            selection.namedtuples.return_value.iterator.return_value = [expired]
            selection.iterator.return_value = [expired]
            cleanup.expire_clips()
            update.assert_called_once_with({"has_clip": False})
            unlink.assert_not_called()
