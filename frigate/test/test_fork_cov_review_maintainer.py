"""Coverage for the review segment maintainer (fork D70).

Exercises PendingReviewSegment, ActiveObjects and ReviewSegmentMaintainer
with a real FrigateConfig, mocked inter-process plumbing, a fake shared
memory frame manager and a temporary clips directory.
"""

import json
import os
import sys
import tempfile
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.comms.detections_updater import DetectionTypeEnum
from frigate.config import FrigateConfig
from frigate.const import CLEAR_ONGOING_REVIEW_SEGMENTS, UPSERT_REVIEW_SEGMENT
from frigate.review import maintainer as maintainer_module
from frigate.review.maintainer import (
    ActiveObjects,
    PendingReviewSegment,
    ReviewSegmentMaintainer,
)
from frigate.review.types import SeverityEnum
from frigate.track.object_processing import ManualEventState

CAMERA = "front"

CONFIG = """
mqtt:
  enabled: False
cameras:
  front:
    ffmpeg:
      inputs:
        - path: rtsp://10.0.0.1:554/video
          roles:
            - detect
            - record
    detect:
      width: 640
      height: 360
      fps: 5
    record:
      enabled: True
    zones:
      porch:
        coordinates: 0,0,320,0,320,360,0,360
      yard:
        coordinates: 320,0,640,0,640,360,320,360
    review:
      alerts:
%(alerts)s
      detections:
%(detections)s
"""

DEFAULT_ALERTS = """        labels:
          - person
          - speech
        required_zones:
          - porch"""

DEFAULT_DETECTIONS = """        labels:
          - person
          - car
          - bark
          - license_plate"""


def make_config(
    alerts: str = DEFAULT_ALERTS, detections: str = DEFAULT_DETECTIONS
) -> FrigateConfig:
    return FrigateConfig.parse_yaml(
        CONFIG % {"alerts": alerts, "detections": detections}
    )


def yuv_frame() -> np.ndarray:
    """A blank I420 frame matching the camera's 640x360 detect size."""
    return np.zeros((540, 640), np.uint8)


def tracked(
    id: str = "p1",
    label: str = "person",
    zones: tuple[str, ...] = ("porch",),
    frame_time: float = 10.0,
    sub_label: Any = None,
    start_time: float = 5.0,
    box: tuple[int, int, int, int] = (100, 100, 200, 300),
    motionless_count: int = 0,
    pending_loitering: bool = False,
    position_changes: int = 1,
    false_positive: bool = False,
) -> dict[str, Any]:
    return {
        "id": id,
        "label": label,
        "current_zones": list(zones),
        "frame_time": frame_time,
        "sub_label": sub_label,
        "start_time": start_time,
        "box": list(box),
        "motionless_count": motionless_count,
        "pending_loitering": pending_loitering,
        "position_changes": position_changes,
        "false_positive": false_positive,
    }


class ClipsDirMixin(unittest.TestCase):
    """Redirect the maintainer's CLIPS_DIR to a temporary directory."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.clips = tmp.name
        patcher = patch.object(maintainer_module, "CLIPS_DIR", self.clips)
        patcher.start()
        self.addCleanup(patcher.stop)


class TestPendingReviewSegment(ClipsDirMixin):
    def setUp(self) -> None:
        super().setUp()
        self.config = make_config()
        self.camera_config = self.config.cameras[CAMERA]

    def test_alert_segment_tracks_alert_time(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.alert, {}, {}, [], set()
        )

        self.assertEqual(segment.last_alert_time, 10.0)
        self.assertEqual(segment.last_detection_time, 10.0)
        self.assertTrue(segment.id.startswith("10.0-"))
        self.assertEqual(
            segment.frame_path,
            os.path.join(self.clips, f"review/thumb-{CAMERA}-{segment.id}.webp"),
        )
        self.assertFalse(segment.has_frame)

    def test_detection_segment_has_no_alert_time(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.detection, {}, {}, [], set()
        )

        self.assertIsNone(segment.last_alert_time)

    def test_get_data_open_and_ended(self) -> None:
        segment = PendingReviewSegment(
            CAMERA,
            10.0,
            SeverityEnum.alert,
            {"a": "person-verified", "b": "car"},
            {"a": "Bob"},
            ["porch"],
            {"speech"},
        )
        segment.last_alert_time = 20.0
        segment.last_detection_time = 25.0

        open_data = segment.get_data(ended=False)
        self.assertIsNone(open_data["end_time"])
        self.assertEqual(open_data["severity"], "alert")
        self.assertEqual(open_data["camera"], CAMERA)
        self.assertEqual(open_data["start_time"], 10.0)
        self.assertEqual(sorted(open_data["data"]["detections"]), ["a", "b"])
        self.assertEqual(
            sorted(open_data["data"]["objects"]), ["car", "person-verified"]
        )
        self.assertEqual(open_data["data"]["verified_objects"], ["person-verified"])
        self.assertEqual(open_data["data"]["sub_labels"], ["Bob"])
        self.assertEqual(open_data["data"]["zones"], ["porch"])
        self.assertEqual(open_data["data"]["audio"], ["speech"])
        self.assertIsNone(open_data["data"]["metadata"])

        # alerts end on the last alert time
        self.assertEqual(segment.get_data(ended=True)["end_time"], 20.0)

        # detections end on the last detection time
        segment.severity = SeverityEnum.detection
        self.assertEqual(segment.get_data(ended=True)["end_time"], 25.0)

    def test_get_data_is_a_copy(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.alert, {}, {}, ["porch"], set()
        )
        data = segment.get_data(False)
        data["data"]["zones"].append("yard")

        self.assertEqual(segment.zones, ["porch"])

    def test_update_frame_writes_thumbnail(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.alert, {}, {}, [], set()
        )
        objects = [tracked(box=(100, 100, 200, 300)), tracked(box=(150, 50, 250, 200))]

        segment.update_frame(self.camera_config, yuv_frame(), objects)

        self.assertTrue(segment.has_frame)
        self.assertEqual(segment.frame_active_count, 2)
        self.assertIsNotNone(segment.thumb_time)
        self.assertTrue(os.path.isfile(segment.frame_path))
        self.assertEqual(segment._frame.shape[0], 180)

    def test_update_frame_without_region_is_a_noop(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.alert, {}, {}, [], set()
        )

        with patch.object(maintainer_module, "calculate_16_9_crop", return_value=None):
            segment.update_frame(self.camera_config, yuv_frame(), [tracked()])

        self.assertFalse(segment.has_frame)
        self.assertEqual(segment.frame_active_count, 0)
        self.assertFalse(os.path.exists(segment.frame_path))

    def test_update_frame_logs_failed_write(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.alert, {}, {}, [], set()
        )

        with (
            patch.object(maintainer_module.cv2, "imwrite", return_value=False),
            self.assertLogs(maintainer_module.logger, "ERROR") as logs,
        ):
            segment.update_frame(self.camera_config, yuv_frame(), [tracked()])

        self.assertTrue(segment.has_frame)
        self.assertIn("Failed to write review thumbnail", logs.output[0])

    def test_save_full_frame_writes_thumbnail(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.detection, {}, {}, [], set()
        )

        segment.save_full_frame(self.camera_config, yuv_frame())

        self.assertTrue(segment.has_frame)
        self.assertTrue(os.path.isfile(segment.frame_path))
        # the full 16:9 frame is scaled to the thumbnail height
        self.assertEqual(segment._frame.shape[:2], (180, 320))

    def test_save_full_frame_logs_failed_write(self) -> None:
        segment = PendingReviewSegment(
            CAMERA, 10.0, SeverityEnum.detection, {}, {}, [], set()
        )

        with (
            patch.object(maintainer_module.cv2, "imwrite", return_value=False),
            self.assertLogs(maintainer_module.logger, "ERROR") as logs,
        ):
            segment.save_full_frame(self.camera_config, yuv_frame())

        self.assertIn("Failed to write review thumbnail", logs.output[0])


class TestActiveObjects(unittest.TestCase):
    def setUp(self) -> None:
        self.config = make_config()
        self.camera_config = self.config.cameras[CAMERA]

    def categorize(
        self, objects: list[dict[str, Any]], camera_config: Any = None
    ) -> ActiveObjects:
        return ActiveObjects(10.0, camera_config or self.camera_config, objects)

    def test_filters_inactive_objects(self) -> None:
        activity = self.categorize(
            [
                tracked(id="stationary", motionless_count=1000),
                tracked(id="never_moved", position_changes=0),
                tracked(id="old_frame", frame_time=9.0),
                tracked(id="false_positive", false_positive=True),
            ]
        )

        self.assertFalse(activity.has_active_objects())
        self.assertEqual(activity.get_all_objects(), [])
        self.assertFalse(activity.has_activity_category(SeverityEnum.alert))
        self.assertFalse(activity.has_activity_category(SeverityEnum.detection))

    def test_loitering_stationary_object_is_kept(self) -> None:
        activity = self.categorize(
            [tracked(id="loiter", motionless_count=1000, pending_loitering=True)]
        )

        self.assertEqual(
            [o["id"] for o in activity.categorized_objects["alerts"]], ["loiter"]
        )

    def test_required_zone_splits_alerts_and_detections(self) -> None:
        activity = self.categorize(
            [
                tracked(id="in_porch", zones=("porch",)),
                tracked(id="in_yard", zones=("yard",)),
                tracked(id="nowhere", zones=()),
                tracked(id="car", label="car", zones=()),
                tracked(id="dog", label="dog"),
            ]
        )

        self.assertEqual(
            [o["id"] for o in activity.categorized_objects["alerts"]], ["in_porch"]
        )
        self.assertEqual(
            [o["id"] for o in activity.categorized_objects["detections"]],
            ["in_yard", "nowhere", "car"],
        )
        self.assertTrue(activity.has_activity_category(SeverityEnum.alert))
        self.assertTrue(activity.has_activity_category(SeverityEnum.detection))
        self.assertEqual(
            [o["id"] for o in activity.get_all_objects()],
            ["in_porch", "in_yard", "nowhere", "car"],
        )

    def test_disabled_alerts_fall_through_to_detections(self) -> None:
        config = make_config(
            alerts="""        enabled: False
        labels:
          - person"""
        )

        activity = self.categorize([tracked()], config.cameras[CAMERA])

        self.assertEqual(activity.categorized_objects["alerts"], [])
        self.assertEqual(len(activity.categorized_objects["detections"]), 1)

    def test_detection_required_zones_and_disabled_detections(self) -> None:
        config = make_config(
            detections="""        required_zones:
          - yard"""
        )
        activity = self.categorize(
            [
                tracked(id="yard_car", label="car", zones=("yard",)),
                tracked(id="porch_car", label="car", zones=("porch",)),
            ],
            config.cameras[CAMERA],
        )
        self.assertEqual(
            [o["id"] for o in activity.categorized_objects["detections"]],
            ["yard_car"],
        )

        disabled = make_config(detections="        enabled: False")
        activity = self.categorize([tracked(label="car")], disabled.cameras[CAMERA])
        self.assertFalse(activity.has_active_objects())


class FakeStopEvent:
    """Stop event that lets the run loop spin a fixed number of times."""

    def __init__(self, iterations: int) -> None:
        self.remaining = iterations

    def is_set(self) -> bool:
        if self.remaining <= 0:
            return True

        self.remaining -= 1
        return False


class MaintainerTestCase(ClipsDirMixin):
    """Build a real ReviewSegmentMaintainer with its plumbing mocked."""

    def setUp(self) -> None:
        super().setUp()
        self.patchers = {
            name: patch.object(maintainer_module, name)
            for name in (
                "SharedMemoryFrameManager",
                "InterProcessRequestor",
                "CameraConfigUpdateSubscriber",
                "DetectionSubscriber",
                "ReviewDataPublisher",
            )
        }
        self.mocks = {name: p.start() for name, p in self.patchers.items()}
        for p in self.patchers.values():
            self.addCleanup(p.stop)

        self.maintainer = self.build()

    def build(self, config: FrigateConfig | None = None) -> ReviewSegmentMaintainer:
        maintainer = ReviewSegmentMaintainer(config or make_config(), MagicMock())
        maintainer.frame_manager.get.return_value = yuv_frame()
        maintainer.config_subscriber.check_for_updates.return_value = {}
        return maintainer

    def sent_topics(self) -> list[str]:
        return [c.args[0] for c in self.maintainer.requestor.send_data.call_args_list]

    def sent(self, topic: str) -> list[Any]:
        return [
            c.args[1]
            for c in self.maintainer.requestor.send_data.call_args_list
            if c.args[0] == topic
        ]

    def run_loop(self, *messages: Any, updates: Any = None) -> None:
        """Run the maintainer loop once per message."""
        self.maintainer.detection_subscriber.check_for_update.side_effect = list(
            messages
        )
        if updates is not None:
            self.maintainer.config_subscriber.check_for_updates.side_effect = updates
        self.maintainer.stop_event = FakeStopEvent(len(messages))
        self.maintainer.run()

    def segment(self, severity: SeverityEnum, start: float = 10.0) -> Any:
        segment = PendingReviewSegment(
            CAMERA, start, severity, {"p1": "person"}, {}, [], set()
        )
        self.maintainer.active_review_segments[CAMERA] = segment
        return segment


class TestMaintainerInit(MaintainerTestCase):
    def test_init_clears_ongoing_segments_and_creates_dir(self) -> None:
        self.assertTrue(os.path.isdir(os.path.join(self.clips, "review")))
        self.assertEqual(self.sent(CLEAR_ONGOING_REVIEW_SEGMENTS), [""])
        self.assertEqual(self.maintainer.active_review_segments, {})
        self.assertEqual(self.maintainer.indefinite_events, {})
        self.assertEqual(self.maintainer.name, "review_segment_maintainer")
        self.mocks["ReviewDataPublisher"].assert_called_once_with("")


class TestPublishing(MaintainerTestCase):
    def test_segment_start_publishes_new(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        self.maintainer.requestor.send_data.reset_mock()

        self.maintainer._publish_segment_start(segment)

        self.assertEqual(
            self.sent_topics(),
            [UPSERT_REVIEW_SEGMENT, "reviews", f"{CAMERA}/review_status"],
        )
        update = json.loads(self.sent("reviews")[0])
        self.assertEqual(update["type"], "new")
        self.assertEqual(update["before"], update["after"])
        self.assertEqual(self.sent(f"{CAMERA}/review_status"), ["ALERT"])
        self.maintainer.review_publisher.publish.assert_called_once()
        self.assertEqual(
            self.maintainer.review_publisher.publish.call_args.args[1], CAMERA
        )

    def test_segment_update_with_frame_writes_thumbnail(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        prev = segment.get_data(False)
        camera_config = self.maintainer.config.cameras[CAMERA]

        self.maintainer._publish_segment_update(
            segment, camera_config, yuv_frame(), [tracked()], prev
        )

        update = json.loads(self.sent("reviews")[0])
        self.assertEqual(update["type"], "update")
        self.assertIsNone(update["before"]["data"]["thumb_time"])
        self.assertIsNotNone(update["after"]["data"]["thumb_time"])
        self.assertTrue(os.path.isfile(segment.frame_path))
        self.assertEqual(self.sent(f"{CAMERA}/review_status"), ["DETECTION"])

    def test_segment_end_clears_active_segment(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        segment.last_alert_time = 33.0

        end_time = self.maintainer._publish_segment_end(
            segment, segment.get_data(False)
        )

        self.assertEqual(end_time, 33.0)
        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])
        self.assertEqual(self.sent(UPSERT_REVIEW_SEGMENT)[-1]["end_time"], 33.0)
        self.assertEqual(json.loads(self.sent("reviews")[0])["type"], "end")
        self.assertEqual(self.sent(f"{CAMERA}/review_status"), ["NONE"])


class TestForciblyEnd(MaintainerTestCase):
    def test_no_segment_returns_none(self) -> None:
        self.assertIsNone(self.maintainer.forcibly_end_segment(CAMERA))
        self.assertNotIn("reviews", self.sent_topics())

    def test_ends_segment(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        segment.last_detection_time = 44.0

        self.assertEqual(self.maintainer.forcibly_end_segment(CAMERA), 44.0)
        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])

    def test_indefinite_event_times_are_capped_to_now(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        segment.last_alert_time = sys.maxsize
        segment.last_detection_time = sys.maxsize
        self.maintainer.indefinite_events[CAMERA] = {"evt": "doorbell"}

        with patch.object(maintainer_module.datetime, "datetime") as fake_datetime:
            fake_datetime.now.return_value.timestamp.return_value = 1234.0
            end_time = self.maintainer.forcibly_end_segment(CAMERA)

        self.assertEqual(end_time, 1234.0)
        self.assertEqual(segment.last_detection_time, 1234.0)
        self.assertEqual(self.maintainer.indefinite_events[CAMERA], {})

    def test_camera_removed_drops_segment_and_events(self) -> None:
        self.segment(SeverityEnum.alert)
        self.maintainer.indefinite_events[CAMERA] = {}

        self.maintainer._handle_camera_removed(CAMERA)

        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])
        self.assertNotIn(CAMERA, self.maintainer.indefinite_events)


class TestUpdateExistingSegment(MaintainerTestCase):
    def test_detection_upgrades_to_alert(self) -> None:
        segment = self.segment(SeverityEnum.detection)

        self.maintainer.update_existing_segment(
            segment, "frame", 20.0, [tracked(frame_time=20.0)]
        )

        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.last_alert_time, 20.0)
        self.assertEqual(segment.zones, ["porch"])
        self.assertTrue(segment.has_frame)
        self.assertEqual(json.loads(self.sent("reviews")[0])["type"], "update")
        self.maintainer.frame_manager.close.assert_called_once_with("frame")

    def test_detection_activity_extends_detection_time(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        segment.frame_active_count = 5

        self.maintainer.update_existing_segment(
            segment,
            "frame",
            20.0,
            [tracked(id="car1", label="car", zones=("yard",), frame_time=20.0)],
        )

        self.assertEqual(segment.severity, SeverityEnum.detection)
        self.assertEqual(segment.last_detection_time, 20.0)
        self.assertEqual(segment.detections["car1"], "car")
        self.assertEqual(segment.zones, ["yard"])
        # nothing new to show, so nothing is published
        self.assertNotIn("reviews", self.sent_topics())

    def test_sub_labels_are_recorded(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        segment.frame_active_count = 5

        self.maintainer.update_existing_segment(
            segment,
            "frame",
            20.0,
            [
                tracked(id="bob", zones=("yard",), frame_time=20.0, sub_label=["Bob"]),
                tracked(
                    id="plate",
                    label="car",
                    zones=("yard",),
                    frame_time=20.0,
                    sub_label=["license_plate", 0.9],
                ),
            ],
        )

        self.assertEqual(segment.detections["bob"], "person-verified")
        self.assertEqual(segment.sub_labels, {"bob": "Bob"})
        self.assertEqual(segment.detections["plate"], "license_plate")
        # sub label change publishes an update without fetching a frame
        self.maintainer.frame_manager.get.assert_not_called()
        update = json.loads(self.sent("reviews")[0])
        self.assertEqual(update["after"]["data"]["sub_labels"], ["Bob"])

    def test_alert_segment_skips_late_detection_objects(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        segment.last_alert_time = 15.0
        segment.frame_active_count = 5

        self.maintainer.update_existing_segment(
            segment,
            "frame",
            20.0,
            [
                tracked(
                    id="late_car",
                    label="car",
                    zones=(),
                    frame_time=20.0,
                    start_time=18.0,
                ),
                tracked(
                    id="early_car",
                    label="car",
                    zones=(),
                    frame_time=20.0,
                    start_time=12.0,
                ),
            ],
        )

        self.assertNotIn("late_car", segment.detections)
        self.assertEqual(segment.detections["early_car"], "car")
        self.assertEqual(segment.last_detection_time, 20.0)
        self.assertEqual(segment.last_alert_time, 15.0)

    def test_missing_frame_skips_publish(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        self.maintainer.frame_manager.get.return_value = None

        self.maintainer.update_existing_segment(
            segment, "frame", 20.0, [tracked(frame_time=20.0)]
        )

        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertNotIn("reviews", self.sent_topics())

    def test_vanished_frame_skips_publish(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        self.maintainer.frame_manager.get.side_effect = FileNotFoundError

        self.maintainer.update_existing_segment(
            segment, "frame", 20.0, [tracked(frame_time=20.0)]
        )

        self.assertNotIn("reviews", self.sent_topics())

    def test_idle_segment_saves_full_frame_once(self) -> None:
        segment = self.segment(SeverityEnum.detection)

        self.maintainer.update_existing_segment(segment, "frame", 11.0, [])

        self.assertTrue(segment.has_frame)
        self.assertTrue(os.path.isfile(segment.frame_path))
        self.assertEqual(json.loads(self.sent("reviews")[0])["type"], "update")
        self.assertIs(self.maintainer.active_review_segments[CAMERA], segment)

        self.maintainer.update_existing_segment(segment, "frame", 12.0, [])
        self.assertEqual(self.maintainer.frame_manager.get.call_count, 1)

    def test_idle_segment_missing_frame_returns(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        self.maintainer.frame_manager.get.return_value = None

        # far past the cutoff, but the early return happens first
        self.maintainer.update_existing_segment(segment, "frame", 500.0, [])

        self.assertFalse(segment.has_frame)
        self.assertIs(self.maintainer.active_review_segments[CAMERA], segment)

    def test_idle_segment_vanished_frame_returns(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        self.maintainer.frame_manager.get.side_effect = FileNotFoundError

        self.maintainer.update_existing_segment(segment, "frame", 500.0, [])

        self.assertIs(self.maintainer.active_review_segments[CAMERA], segment)

    def test_detection_segment_ends_after_cutoff(self) -> None:
        segment = self.segment(SeverityEnum.detection)
        segment.has_frame = True

        self.maintainer.update_existing_segment(segment, "frame", 30.0, [])
        self.assertIs(self.maintainer.active_review_segments[CAMERA], segment)

        self.maintainer.update_existing_segment(segment, "frame", 41.0, [])
        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])
        self.assertEqual(self.sent(UPSERT_REVIEW_SEGMENT)[-1]["end_time"], 10.0)

    def test_alert_segment_ends_after_cutoff(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        segment.has_frame = True

        self.maintainer.update_existing_segment(segment, "frame", 50.0, [])
        self.assertIs(self.maintainer.active_review_segments[CAMERA], segment)

        self.maintainer.update_existing_segment(segment, "frame", 51.0, [])
        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])

    def test_alert_end_with_recent_detection_and_no_activity(self) -> None:
        # the detection outlived the alert, but with no active objects
        # there is nothing to carry into a follow-up detection segment
        segment = self.segment(SeverityEnum.alert)
        segment.has_frame = True
        segment.last_detection_time = 45.0

        self.maintainer.update_existing_segment(segment, "frame", 51.0, [])

        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])

    def test_alert_end_starts_follow_up_detection_segment(self) -> None:
        # ActiveObjects is stubbed so the follow-up branch sees a
        # detection while the segment itself reports no activity
        segment = self.segment(SeverityEnum.alert)
        segment.has_frame = True
        segment.last_detection_time = 45.0
        car = tracked(id="car1", label="car", zones=("yard",))

        stub = MagicMock()
        stub.has_active_objects.return_value = False
        stub.categorized_objects = {"alerts": [], "detections": [car]}

        with patch.object(maintainer_module, "ActiveObjects", return_value=stub):
            self.maintainer.update_existing_segment(segment, "frame", 51.0, [car])

        follow_up = self.maintainer.active_review_segments[CAMERA]
        self.assertIsNotNone(follow_up)
        self.assertIsNot(follow_up, segment)
        self.assertEqual(follow_up.severity, SeverityEnum.detection)
        self.assertEqual(follow_up.start_time, 10.0)
        self.assertEqual(follow_up.detections, {"car1": "car"})
        self.assertEqual(follow_up.zones, ["yard"])
        self.assertEqual(follow_up.last_detection_time, 45.0)
        types = [json.loads(r)["type"] for r in self.sent("reviews")]
        self.assertEqual(types, ["end", "new"])


class TestCheckIfNewSegment(MaintainerTestCase):
    def test_alert_segment_is_started(self) -> None:
        self.maintainer.check_if_new_segment(
            CAMERA,
            "frame",
            10.0,
            [
                tracked(id="bob", sub_label=["Bob"]),
                tracked(id="pkg", label="car", zones=("yard",), sub_label=["ups"]),
                tracked(id="car", label="car", zones=("yard",)),
            ],
        )

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(
            segment.detections,
            {"bob": "person-verified", "pkg": "ups", "car": "car"},
        )
        self.assertEqual(segment.sub_labels, {"bob": "Bob"})
        self.assertEqual(segment.zones, ["porch", "yard"])
        self.assertTrue(segment.has_frame)
        self.assertEqual(json.loads(self.sent("reviews")[0])["type"], "new")
        self.assertEqual(self.sent(f"{CAMERA}/review_status"), ["ALERT"])

    def test_detection_segment_is_started(self) -> None:
        self.maintainer.check_if_new_segment(
            CAMERA, "frame", 10.0, [tracked(id="car", label="car", zones=())]
        )

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.detection)
        self.assertEqual(segment.zones, [])

    def test_no_activity_starts_nothing(self) -> None:
        self.maintainer.check_if_new_segment(
            CAMERA, "frame", 10.0, [tracked(label="dog")]
        )

        self.assertNotIn(CAMERA, self.maintainer.active_review_segments)

    def test_missing_frame_keeps_segment_unpublished(self) -> None:
        self.maintainer.frame_manager.get.return_value = None

        self.maintainer.check_if_new_segment(CAMERA, "frame", 10.0, [tracked()])

        self.assertIsNotNone(self.maintainer.active_review_segments[CAMERA])
        self.assertNotIn("reviews", self.sent_topics())

    def test_vanished_frame_keeps_segment_unpublished(self) -> None:
        self.maintainer.frame_manager.get.side_effect = FileNotFoundError

        self.maintainer.check_if_new_segment(CAMERA, "frame", 10.0, [tracked()])

        self.assertIsNotNone(self.maintainer.active_review_segments[CAMERA])
        self.assertNotIn("reviews", self.sent_topics())


def video(frame_time: float, objects: list, camera: str = CAMERA) -> tuple:
    return (
        DetectionTypeEnum.video.value,
        (camera, "frame", frame_time, objects, None, None),
    )


def audio(frame_time: float, labels: list[str], camera: str = CAMERA) -> tuple:
    return (DetectionTypeEnum.audio.value, (camera, frame_time, None, labels))


def manual(
    topic: DetectionTypeEnum,
    state: ManualEventState,
    frame_time: float,
    label: str = "doorbell",
    event_id: str = "evt1",
    end_time: float | None = None,
) -> tuple:
    return (
        topic.value,
        (
            CAMERA,
            frame_time,
            {
                "state": state,
                "event_id": event_id,
                "label": label,
                "end_time": end_time,
            },
        ),
    )


class TestRunLoop(MaintainerTestCase):
    def test_shutdown_stops_plumbing(self) -> None:
        self.run_loop()

        self.maintainer.config_subscriber.stop.assert_called_once()
        self.maintainer.requestor.stop.assert_called_once()
        self.maintainer.detection_subscriber.stop.assert_called_once()

    def test_config_updates_end_segments(self) -> None:
        with patch.object(self.maintainer, "forcibly_end_segment") as end:
            self.run_loop(
                None,
                updates=[
                    {"record": ["a"], "enabled": ["b"], "remove": [CAMERA]},
                ],
            )

        self.assertEqual([c.args[0] for c in end.call_args_list], ["a", "b", CAMERA])

    def test_empty_messages_are_ignored(self) -> None:
        self.run_loop(None, ("", None), (DetectionTypeEnum.video.value, None))

        self.assertEqual(self.maintainer.active_review_segments, {})

    def test_unknown_and_disabled_cameras_are_ignored(self) -> None:
        self.maintainer.config.cameras[CAMERA].record.enabled = False

        self.run_loop(
            video(10.0, [tracked()], camera="ghost"), video(10.0, [tracked()])
        )

        self.assertEqual(self.maintainer.active_review_segments, {})

    def test_video_starts_then_updates_segment(self) -> None:
        self.run_loop(
            video(10.0, [tracked(frame_time=10.0)]),
            video(11.0, [tracked(frame_time=11.0)]),
        )

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.last_alert_time, 11.0)

    def test_segment_with_disabled_severity_is_ended(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        self.maintainer.config.cameras[CAMERA].review.alerts.enabled = False

        self.run_loop(video(11.0, []))

        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])
        self.assertEqual(segment.get_data(True)["end_time"], 10.0)

    def test_detection_segment_with_detections_disabled_is_ended(self) -> None:
        self.segment(SeverityEnum.detection)
        self.maintainer.config.cameras[CAMERA].review.detections.enabled = False

        self.run_loop(video(11.0, []))

        self.assertIsNone(self.maintainer.active_review_segments[CAMERA])

    def test_audio_on_existing_segment(self) -> None:
        segment = self.segment(SeverityEnum.detection)

        self.run_loop(audio(12.0, ["bark"]), audio(13.0, ["speech", "music"]))

        self.assertEqual(segment.audio, {"bark", "speech"})
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.last_alert_time, 13.0)
        self.assertEqual(segment.last_detection_time, 12.0)

    def test_audio_starts_alert_segment(self) -> None:
        self.run_loop(audio(12.0, ["bark", "speech"]))

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.audio, {"bark", "speech"})
        self.assertEqual(segment.detections, {})

    def test_audio_starts_detection_segment(self) -> None:
        self.run_loop(audio(12.0, ["bark"]))

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.detection)

    def test_unmatched_audio_starts_nothing(self) -> None:
        self.run_loop(audio(12.0, ["music"]), audio(13.0, []))

        self.assertNotIn(CAMERA, self.maintainer.active_review_segments)

    def test_api_complete_on_existing_segments(self) -> None:
        segment = self.segment(SeverityEnum.detection)

        self.run_loop(
            manual(
                DetectionTypeEnum.api,
                ManualEventState.complete,
                12.0,
                label="car",
                event_id="car_evt",
                end_time=20.0,
            ),
            manual(
                DetectionTypeEnum.api,
                ManualEventState.complete,
                13.0,
                label="person",
                event_id="person_evt",
                end_time=25.0,
            ),
        )

        self.assertEqual(segment.detections["car_evt"], "car")
        self.assertEqual(segment.detections["person_evt"], "person")
        self.assertEqual(segment.last_detection_time, 20.0)
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.last_alert_time, 25.0)
        self.assertEqual(self.maintainer.indefinite_events, {CAMERA: {}})

    def test_api_start_and_end_on_existing_segment(self) -> None:
        segment = self.segment(SeverityEnum.detection)

        self.run_loop(
            manual(DetectionTypeEnum.api, ManualEventState.start, 12.0),
        )
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.last_alert_time, sys.maxsize)
        self.assertEqual(segment.last_detection_time, sys.maxsize)
        self.assertEqual(
            self.maintainer.indefinite_events[CAMERA], {"evt1": "doorbell"}
        )

        self.run_loop(
            manual(DetectionTypeEnum.api, ManualEventState.end, 30.0, end_time=30.0)
        )
        self.assertEqual(self.maintainer.indefinite_events[CAMERA], {})
        self.assertEqual(segment.last_alert_time, 30.0)
        self.assertEqual(segment.last_detection_time, 30.0)

    def test_end_keeps_segment_open_while_other_events_run(self) -> None:
        segment = self.segment(SeverityEnum.alert)
        self.maintainer.indefinite_events[CAMERA] = {"a": "x", "b": "y"}
        segment.last_alert_time = sys.maxsize

        self.run_loop(
            manual(
                DetectionTypeEnum.api,
                ManualEventState.end,
                30.0,
                event_id="a",
                end_time=30.0,
            )
        )

        self.assertEqual(self.maintainer.indefinite_events[CAMERA], {"b": "y"})
        self.assertEqual(segment.last_alert_time, sys.maxsize)

    def test_end_of_unknown_event_logs_error(self) -> None:
        self.segment(SeverityEnum.alert)

        with self.assertLogs(maintainer_module.logger, "ERROR") as logs:
            self.run_loop(
                manual(
                    DetectionTypeEnum.api,
                    ManualEventState.end,
                    30.0,
                    event_id="nope",
                    end_time=30.0,
                )
            )

        self.assertIn("nope", logs.output[0])

    def test_lpr_start_on_existing_detection_segment(self) -> None:
        segment = self.segment(SeverityEnum.detection)

        self.run_loop(
            manual(
                DetectionTypeEnum.lpr,
                ManualEventState.start,
                12.0,
                label="license_plate",
            )
        )

        self.assertEqual(segment.severity, SeverityEnum.detection)
        self.assertEqual(segment.detections["evt1"], "license_plate")
        self.assertEqual(segment.last_detection_time, sys.maxsize)

    def test_lpr_complete_extends_detection_time_only(self) -> None:
        segment = self.segment(SeverityEnum.alert)

        self.run_loop(
            manual(
                DetectionTypeEnum.lpr,
                ManualEventState.complete,
                12.0,
                label="license_plate",
                end_time=18.0,
            )
        )

        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.last_alert_time, 10.0)
        self.assertEqual(segment.last_detection_time, 18.0)

    def test_api_start_creates_indefinite_segment(self) -> None:
        self.run_loop(manual(DetectionTypeEnum.api, ManualEventState.start, 12.0))

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertEqual(segment.detections, {"evt1": "doorbell"})
        self.assertEqual(segment.last_alert_time, sys.maxsize)
        self.assertEqual(segment.last_detection_time, sys.maxsize)
        self.assertEqual(
            self.maintainer.indefinite_events[CAMERA], {"evt1": "doorbell"}
        )

    def test_api_complete_creates_bounded_detection_segment(self) -> None:
        self.run_loop(
            manual(
                DetectionTypeEnum.api,
                ManualEventState.complete,
                12.0,
                label="car",
                end_time=22.0,
            )
        )

        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.detection)
        self.assertEqual(segment.last_alert_time, 22.0)
        self.assertEqual(segment.last_detection_time, 22.0)
        self.assertEqual(self.maintainer.indefinite_events[CAMERA], {})

    def test_api_with_review_disabled_warns(self) -> None:
        review = self.maintainer.config.cameras[CAMERA].review
        review.alerts.enabled = False
        review.detections.enabled = False

        with self.assertLogs(maintainer_module.logger, "WARNING") as logs:
            self.run_loop(
                manual(DetectionTypeEnum.api, ManualEventState.start, 12.0),
                video(13.0, [tracked(frame_time=13.0)]),
            )

        self.assertNotIn(CAMERA, self.maintainer.active_review_segments)
        self.assertIn("alerts and detections are disabled", logs.output[0])

    def test_lpr_start_and_complete_create_detection_segments(self) -> None:
        self.run_loop(
            manual(
                DetectionTypeEnum.lpr,
                ManualEventState.start,
                12.0,
                label="license_plate",
            )
        )
        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.severity, SeverityEnum.detection)
        self.assertEqual(segment.last_detection_time, sys.maxsize)
        self.assertEqual(
            self.maintainer.indefinite_events[CAMERA], {"evt1": "license_plate"}
        )

        self.maintainer.active_review_segments = {}
        self.run_loop(
            manual(
                DetectionTypeEnum.lpr,
                ManualEventState.complete,
                14.0,
                label="license_plate",
                event_id="evt2",
                end_time=19.0,
            )
        )
        segment = self.maintainer.active_review_segments[CAMERA]
        self.assertEqual(segment.start_time, 14.0)
        self.assertEqual(segment.last_detection_time, 19.0)
        self.assertEqual(segment.last_alert_time, 19.0)

    def test_lpr_with_detections_disabled_warns(self) -> None:
        self.maintainer.config.cameras[CAMERA].review.detections.enabled = False

        with self.assertLogs(maintainer_module.logger, "WARNING") as logs:
            self.run_loop(
                manual(
                    DetectionTypeEnum.lpr,
                    ManualEventState.complete,
                    12.0,
                    label="license_plate",
                    end_time=15.0,
                )
            )

        self.assertNotIn(CAMERA, self.maintainer.active_review_segments)
        self.assertIn("detections are disabled", logs.output[0])


if __name__ == "__main__":
    unittest.main()
