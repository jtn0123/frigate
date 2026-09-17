"""Recording cleanup keeps the pre-capture of reviews just after the cutoff."""

import datetime
import tempfile
import unittest
from pathlib import Path

from peewee import SqliteDatabase

from frigate.config import FrigateConfig
from frigate.models import Previews, Recordings, ReviewSegment, UserReviewStatus
from frigate.record.cleanup import RecordingCleanup

MODELS = [Previews, Recordings, ReviewSegment, UserReviewStatus]


class TestRecordCleanupPreCapture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = SqliteDatabase(":memory:")
        self.binding = self.database.bind_ctx(MODELS)
        self.binding.__enter__()
        self.addCleanup(self.binding.__exit__, None, None, None)
        self.database.create_tables(MODELS)
        self.addCleanup(self.database.close)
        self.config = FrigateConfig(
            mqtt={"enabled": False},
            cameras={
                "front": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {"height": 1080, "width": 1920, "fps": 5},
                    "record": {
                        "enabled": True,
                        "continuous": {"days": 1},
                        "alerts": {"pre_capture": 5, "retain": {"mode": "all"}},
                    },
                }
            },
        )

    def test_keeps_pre_roll_of_an_alert_starting_just_after_the_cutoff(self):
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=1)).timestamp()
        path = Path(self.temp.name) / "pre-roll.mp4"
        path.write_bytes(b"recording")
        # No motion, so continuous retention alone would expire it
        Recordings.create(
            id="pre-roll",
            camera="front",
            path=str(path),
            start_time=cutoff - 10,
            end_time=cutoff - 1,
            duration=9,
            motion=0,
            objects=0,
            dBFS=0,
        )
        ReviewSegment.create(
            id="alert",
            camera="front",
            start_time=cutoff + 2,
            end_time=cutoff + 30,
            severity="alert",
            thumb_path=str(Path(self.temp.name) / "alert.webp"),
            data={},
        )

        RecordingCleanup(self.config, None).expire_recordings()

        self.assertTrue(path.exists())
        self.assertEqual(Recordings.select().count(), 1)


if __name__ == "__main__":
    unittest.main()
