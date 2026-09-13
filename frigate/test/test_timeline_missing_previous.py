"""Updates without previous object state cannot crash timeline processing."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from frigate.events.types import EventStateEnum
from frigate.timeline import TimelineProcessor


class TestTimelineMissingPrevious(unittest.TestCase):
    def test_update_and_end_ignore_missing_previous_state(self):
        processor = TimelineProcessor(
            SimpleNamespace(
                cameras={
                    "camera": SimpleNamespace(
                        detect=SimpleNamespace(width=640, height=480)
                    )
                }
            ),
            Mock(),
            Mock(),
        )
        processor.insert_or_save = Mock()
        for state in [EventStateEnum.update, EventStateEnum.end]:
            with self.subTest(state=state):
                processor.handle_object_detection(
                    "camera",
                    state,
                    None,
                    {
                        "id": "event",
                        "frame_time": 1,
                        "box": [0, 0, 20, 20],
                        "region": [0, 0, 40, 40],
                        "label": "person",
                        "score": 0.9,
                    },
                )
        processor.insert_or_save.assert_not_called()
