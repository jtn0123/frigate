"""G18: recording cleanup expires the rows of deleted cameras by index seek."""

import datetime
import tempfile
import unittest

from peewee import SqliteDatabase

from frigate.config import FrigateConfig
from frigate.models import Previews, Recordings, ReviewSegment, UserReviewStatus
from frigate.record.cleanup import RecordingCleanup

MODELS = [Previews, Recordings, ReviewSegment, UserReviewStatus]


def _config(record: dict, global_record: dict | None = None) -> FrigateConfig:
    data: dict = {
        "mqtt": {"host": "mqtt"},
        "cameras": {
            "front_door": {
                "ffmpeg": {
                    "inputs": [
                        {
                            "path": "rtsp://10.0.0.1:554/video",
                            "roles": ["detect", "record"],
                        },
                    ]
                },
                "detect": {"height": 1080, "width": 1920, "fps": 5},
                "record": record,
            }
        },
    }
    if global_record is not None:
        data["record"] = global_record
    return FrigateConfig(**data)


class TestRecordCleanupDeletedCameras(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = SqliteDatabase(":memory:")
        self.binding = self.database.bind_ctx(MODELS)
        self.binding.__enter__()
        self.addCleanup(self.binding.__exit__, None, None, None)
        self.database.create_tables(MODELS)
        self.addCleanup(self.database.close)

    def _insert_recording(
        self, id: str, age_days: float, camera: str = "front_door", motion: int = 0
    ) -> None:
        end_time = (
            datetime.datetime.now() - datetime.timedelta(days=age_days)
        ).timestamp()
        Recordings.create(
            id=id,
            camera=camera,
            path=f"{self.temp.name}/{id}.mp4",
            start_time=end_time - 10,
            end_time=end_time,
            duration=10,
            motion=motion,
            objects=0,
            dBFS=0,
            segment_size=1,
        )

    def test_deleted_camera_recordings_expire(self):
        # rows for a camera no longer in the config expire by the GLOBAL
        # record retention window; newer orphan rows and configured-camera
        # rows are untouched by the deleted-cameras sweep
        config = _config(
            {"enabled": True, "continuous": {"days": 7}},
            global_record={"continuous": {"days": 7}},
        )
        self._insert_recording("gone_old", 10, camera="removed_cam")
        self._insert_recording("gone_new", 5, camera="removed_cam")
        self._insert_recording("gone_blank", 10, camera="")
        self._insert_recording("kept", 5)

        RecordingCleanup(config, None).expire_recordings()

        self.assertIsNone(Recordings.get_or_none(Recordings.id == "gone_old"))
        self.assertIsNotNone(Recordings.get_or_none(Recordings.id == "gone_new"))
        # empty-string camera names sort before every real name and must
        # still be enumerated by the sweep
        self.assertIsNone(Recordings.get_or_none(Recordings.id == "gone_blank"))
        self.assertIsNotNone(Recordings.get_or_none(Recordings.id == "kept"))

    def test_expire_bound_keeps_the_same_rows(self):
        # the start_time bound on the expire query must not change which
        # rows expire: motion rows follow motion retention, the rest follow
        # continuous retention
        config = _config(
            {"enabled": True, "continuous": {"days": 2}, "motion": {"days": 5}}
        )
        self._insert_recording("still_old", 3)
        self._insert_recording("still_new", 1)
        self._insert_recording("motion_mid", 3, motion=1)
        self._insert_recording("motion_old", 6, motion=1)

        RecordingCleanup(config, None).expire_recordings()

        remaining = sorted(r.id for r in Recordings.select(Recordings.id))
        self.assertEqual(remaining, ["motion_mid", "still_new"])


if __name__ == "__main__":
    unittest.main()
