"""Recordings summary on the day a DST period boundary falls in (G18).

The summary walks each DST period day by day. The transition day belongs to
both periods, so once the first period has marked it the second must skip it
rather than query it again or count it twice."""

import json
import unittest
from datetime import datetime
from types import SimpleNamespace

import pytz
from playhouse.sqlite_ext import SqliteExtDatabase

from frigate.api.defs.query.recordings_query_parameters import (
    MediaRecordingsSummaryQueryParams,
)
from frigate.api.record import all_recordings_summary
from frigate.models import Recordings

TZ = pytz.timezone("America/New_York")


def _ts(*args) -> float:
    return TZ.localize(datetime(*args)).timestamp()


class TestRecordingsSummaryTransitionDay(unittest.TestCase):
    def setUp(self):
        self.db = SqliteExtDatabase(":memory:")
        Recordings.bind(self.db, bind_refs=False, bind_backrefs=False)
        self.db.connect()
        self.db.create_tables([Recordings])

    def tearDown(self):
        self.db.close()

    def _record(self, rec_id: str, start: float, camera: str = "front") -> None:
        Recordings.create(
            id=rec_id,
            camera=camera,
            path=f"/media/recordings/{rec_id}.mp4",
            start_time=start,
            end_time=start + 60,
            duration=60,
        )

    def _summary(self, cameras: str = "all") -> dict[str, bool]:
        response = all_recordings_summary(
            SimpleNamespace(),
            MediaRecordingsSummaryQueryParams(
                timezone="America/New_York", cameras=cameras
            ),
            allowed_cameras=["front", "back"],
        )
        return json.loads(response.body)

    def test_transition_day_is_listed_once(self):
        # before and after the 2024-03-10 02:00 spring forward, plus the next day
        self._record("before", _ts(2024, 3, 10, 1, 0))
        self._record("after", _ts(2024, 3, 10, 15, 0))
        self._record("next", _ts(2024, 3, 11, 9, 0), camera="back")

        self.assertEqual(self._summary(), {"2024-03-10": True, "2024-03-11": True})

    def test_camera_filter_only_counts_that_camera(self):
        self._record("before", _ts(2024, 3, 10, 1, 0))
        self._record("next", _ts(2024, 3, 11, 9, 0), camera="back")

        self.assertEqual(self._summary("back"), {"2024-03-11": True})
        self.assertEqual(self._summary("attic"), {})


if __name__ == "__main__":
    unittest.main()
