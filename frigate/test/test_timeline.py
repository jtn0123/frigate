import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from peewee import SqliteDatabase

from frigate.events.cleanup import EventCleanup
from frigate.events.types import EventStateEnum
from frigate.models import Event, Timeline
from frigate.timeline import TimelineProcessor


def make_event(has_clip: bool, has_snapshot: bool) -> dict:
    return {
        "id": "event-1",
        "frame_time": 1000.0,
        "box": [0, 0, 10, 10],
        "region": [0, 0, 100, 100],
        "label": "car",
        "sub_label": None,
        "score": 0.8,
        "has_clip": has_clip,
        "has_snapshot": has_snapshot,
        "current_zones": [],
        "stationary": False,
        "attributes": {},
        "current_attributes": [],
    }


class TestTimelineProcessor(unittest.TestCase):
    def setUp(self):
        camera_config = MagicMock()
        camera_config.detect.width = 1280
        camera_config.detect.height = 720
        config = MagicMock()
        config.cameras.get.return_value = camera_config
        self.processor = TimelineProcessor(config, MagicMock(), MagicMock())

    @patch.object(Timeline, "insert")
    def test_unsaved_event_writes_no_timeline_rows(self, insert):
        event = make_event(has_clip=False, has_snapshot=False)
        self.processor.handle_object_detection(
            "front", EventStateEnum.start, None, event
        )
        self.processor.handle_object_detection(
            "front", EventStateEnum.end, event, event
        )

        insert.assert_not_called()
        self.assertEqual(self.processor.pre_event_cache, {})

    @patch.object(Timeline, "insert")
    def test_cached_entries_flush_when_event_is_saved(self, insert):
        start = make_event(has_clip=False, has_snapshot=False)
        self.processor.handle_object_detection(
            "front", EventStateEnum.start, None, start
        )
        insert.assert_not_called()

        end = make_event(has_clip=True, has_snapshot=False)
        self.processor.handle_object_detection("front", EventStateEnum.end, start, end)

        class_types = [c.args[0][Timeline.class_type] for c in insert.call_args_list]
        self.assertEqual(class_types, ["visible", "gone"])
        self.assertEqual(self.processor.pre_event_cache, {})


class TestExpiredEventTimelineCleanup(unittest.TestCase):
    """B32 (upstream #24510): expiring a clipless event drops its timeline."""

    def setUp(self):
        self.database = SqliteDatabase(":memory:")
        binding = self.database.bind_ctx([Event, Timeline])
        binding.__enter__()
        self.addCleanup(binding.__exit__, None, None, None)
        self.database.create_tables([Event, Timeline])
        self.addCleanup(self.database.close)

    def add_event(self, event_id: str, saved: bool) -> None:
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
            has_clip=saved,
            has_snapshot=saved,
            region=[],
            box=[],
            area=0,
            plus_id="",
            model_hash="",
            detector_type="",
            model_type="",
            data={},
        )
        Timeline.create(
            timestamp=now - 60,
            camera="front",
            source="tracked_object",
            source_id=event_id,
            class_type="visible",
            data={},
        )

    def test_timeline_rows_go_with_the_expired_event(self):
        self.add_event("expired", saved=False)
        self.add_event("kept", saved=True)

        stop_event = Mock()
        stop_event.wait.side_effect = [False, True]
        cleanup = EventCleanup(
            SimpleNamespace(cameras={}, safe_mode=False), stop_event, Mock()
        )
        with (
            patch.object(cleanup, "expire_clips", return_value=[]),
            patch.object(cleanup, "expire_snapshots", return_value=[]),
            patch("frigate.events.cleanup.delete_event_thumbnail"),
            patch("frigate.events.cleanup.expire_share_links"),
        ):
            cleanup.run()

        self.assertEqual({e.id for e in Event.select()}, {"kept"})
        self.assertEqual({t.source_id for t in Timeline.select()}, {"kept"})


if __name__ == "__main__":
    unittest.main()
