"""Event cleanup removes share links that expired long ago or lost their event."""

import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from peewee import SqliteDatabase

from frigate.events.cleanup import EventCleanup
from frigate.events.share_links import EXPIRED_LINK_GRACE
from frigate.models import Event, ShareLink, Timeline

MODELS = [Event, ShareLink, Timeline]


class TestShareLinkCleanup(unittest.TestCase):
    def setUp(self):
        self.database = SqliteDatabase(":memory:")
        self.binding = self.database.bind_ctx(MODELS)
        self.binding.__enter__()
        self.addCleanup(self.binding.__exit__, None, None, None)
        self.database.create_tables(MODELS)
        self.addCleanup(self.database.close)

    def add_event(self, event_id: str, has_clip: bool) -> None:
        now = time.time()
        Event.create(
            id=event_id,
            label="person",
            camera="front",
            start_time=now - 60,
            end_time=now - 30,
            top_score=0,
            score=0,
            false_positive=False,
            zones=[],
            thumbnail="",
            has_clip=has_clip,
            has_snapshot=has_clip,
            region=[],
            box=[],
            area=0,
            plus_id="",
            model_hash="",
            detector_type="",
            model_type="",
            data={},
        )

    def add_link(self, token: str, event_id: str, expires_at: float) -> None:
        ShareLink.create(
            token=token,
            event_id=event_id,
            camera="front",
            created_by="admin",
            created_at=expires_at - 3600,
            expires_at=expires_at,
        )

    def test_cleanup_pass_deletes_stale_and_orphaned_links(self):
        now = time.time()
        self.add_event("kept", has_clip=True)
        self.add_event("expired-by-retention", has_clip=False)
        self.add_link("live", "kept", now + 3600)
        self.add_link("recently-expired", "kept", now - 3600)
        self.add_link("long-expired", "kept", now - EXPIRED_LINK_GRACE - 60)
        self.add_link("event-deleted-now", "expired-by-retention", now + 3600)
        self.add_link("event-gone", "never-existed", now + 3600)

        stop_event = Mock()
        stop_event.wait.side_effect = [False, True]
        cleanup = EventCleanup(
            SimpleNamespace(cameras={}, safe_mode=False), stop_event, Mock()
        )
        with (
            patch.object(cleanup, "expire_clips", return_value=[]),
            patch.object(cleanup, "expire_snapshots", return_value=[]),
            patch("frigate.events.cleanup.delete_event_thumbnail"),
        ):
            cleanup.run()

        self.assertEqual(
            {link.token for link in ShareLink.select()},
            {"live", "recently-expired"},
        )


if __name__ == "__main__":
    unittest.main()
