"""Fork (D32): a license plate read on a segment in progress.

A dedicated LPR camera reports plates as detections. When one arrives while a
review segment is already open, it must not turn an alert into a detection,
and it extends the segment through its detection time, not its alert time.
"""

import unittest
from unittest.mock import MagicMock

from frigate.comms.detections_updater import DetectionTypeEnum
from frigate.config import FrigateConfig
from frigate.review.maintainer import PendingReviewSegment, ReviewSegmentMaintainer
from frigate.review.types import SeverityEnum
from frigate.track.object_processing import ManualEventState

CONFIG = """
mqtt:
  enabled: False
cameras:
  plates:
    ffmpeg:
      inputs:
        - path: rtsp://10.0.0.1:554/video
          roles:
            - detect
            - record
    detect:
      width: 1920
      height: 1080
      fps: 5
    record:
      enabled: True
"""


def deliver_plate(
    segment: PendingReviewSegment, state: ManualEventState, end_time: float
) -> None:
    """Run the maintainer loop once with a single LPR message for `segment`."""
    maintainer = ReviewSegmentMaintainer.__new__(ReviewSegmentMaintainer)
    maintainer.config = FrigateConfig.parse_yaml(CONFIG)
    maintainer.config_subscriber = MagicMock()
    maintainer.config_subscriber.check_for_updates.return_value = {}
    maintainer.detection_subscriber = MagicMock()
    maintainer.detection_subscriber.check_for_update.return_value = (
        DetectionTypeEnum.lpr.value,
        (
            "plates",
            end_time,
            {
                "state": state,
                "event_id": "plate-1",
                "label": "license_plate",
                "end_time": end_time,
            },
        ),
    )
    maintainer.requestor = MagicMock()
    maintainer.stop_event = MagicMock()
    maintainer.stop_event.is_set.side_effect = [False, True]
    maintainer.indefinite_events = {}
    maintainer.active_review_segments = {"plates": segment}

    maintainer.run()


def segment(severity: SeverityEnum) -> PendingReviewSegment:
    return PendingReviewSegment(
        "plates", 100.0, severity, {"car-1": "car"}, {}, [], set()
    )


class TestLprOnExistingSegment(unittest.TestCase):
    def test_completed_plate_keeps_an_alert_an_alert(self) -> None:
        alert = segment(SeverityEnum.alert)
        alert.last_alert_time = 150.0

        deliver_plate(alert, ManualEventState.complete, 160.0)

        self.assertEqual(alert.severity, SeverityEnum.alert)
        self.assertEqual(alert.last_alert_time, 150.0)
        self.assertEqual(alert.last_detection_time, 160.0)
        self.assertEqual(alert.detections["plate-1"], "license_plate")

    def test_started_plate_keeps_an_alert_an_alert(self) -> None:
        alert = segment(SeverityEnum.alert)

        deliver_plate(alert, ManualEventState.start, 120.0)

        self.assertEqual(alert.severity, SeverityEnum.alert)

    def test_completed_plate_extends_a_detection(self) -> None:
        detection = segment(SeverityEnum.detection)

        deliver_plate(detection, ManualEventState.complete, 160.0)

        self.assertEqual(detection.severity, SeverityEnum.detection)
        self.assertEqual(detection.last_detection_time, 160.0)
        self.assertIsNone(detection.last_alert_time)


if __name__ == "__main__":
    unittest.main(verbosity=2)
