"""Fork (D77): exclusion zones keep objects out of review, not out of tracking."""

import tempfile
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.config import FrigateConfig
from frigate.fork.exclusion_zones import excluded_from_review, exclusion_zone_names
from frigate.review import maintainer as maintainer_module
from frigate.review.maintainer import ActiveObjects, ReviewSegmentMaintainer
from frigate.review.types import SeverityEnum
from frigate.track.tracked_object import TrackedObject

# 640x360: the far road is the top third, the driveway the bottom right.
CONFIG = {
    "mqtt": {"enabled": False},
    "cameras": {
        "front": {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://test/front", "roles": ["detect", "record"]}]
            },
            "detect": {"width": 640, "height": 360, "fps": 5},
            "record": {"enabled": True},
            "objects": {"track": ["person", "car"]},
            "review": {
                "alerts": {"labels": ["person", "car"]},
                "detections": {"labels": ["person", "car"]},
            },
            "zones": {
                "far_road": {
                    "coordinates": "0,0,1,0,1,0.33,0,0.33",
                    "exclusion": True,
                },
                "driveway": {"coordinates": "0.5,0.5,1,0.5,1,1,0.5,1"},
            },
        }
    },
}

ROAD_BOX = (100, 40, 200, 100)  # bottom center (150, 100): on the far road
LAWN_BOX = (100, 200, 200, 300)  # bottom center (150, 300): outside every zone
DRIVEWAY_BOX = (400, 250, 500, 340)  # bottom center (450, 340): in the driveway
# a second exclusion zone just under the far road, on the left
VERGE = {"coordinates": "0,0.33,0.25,0.33,0.25,0.5,0,0.5", "exclusion": True}
VERGE_BOX = (20, 100, 60, 150)  # bottom center (40, 150): on the verge


def make_config(**zone_changes: dict[str, Any]) -> FrigateConfig:
    raw = {**CONFIG, "cameras": {"front": dict(CONFIG["cameras"]["front"])}}
    zones = {
        name: dict(zone) for name, zone in CONFIG["cameras"]["front"]["zones"].items()
    }
    for name, changes in zone_changes.items():
        zones[name] = zones.get(name, {}) | changes
    raw["cameras"]["front"]["zones"] = zones
    return FrigateConfig(**raw)


def tracked(
    *,
    entered=(),
    current=(),
    box=ROAD_BOX,
    label="car",
    object_id="1.0-car",
) -> dict[str, Any]:
    return {
        "id": object_id,
        "label": label,
        "sub_label": None,
        "box": box,
        "frame_time": 10.0,
        "start_time": 9.0,
        "motionless_count": 0,
        "position_changes": 2,
        "false_positive": False,
        "pending_loitering": False,
        "current_zones": list(current),
        "entered_zones": list(entered),
    }


def detection(
    box: tuple[int, int, int, int], when: float, score: float = 0.9, label="car"
) -> dict[str, Any]:
    return {
        "id": "1.0-car",
        "label": label,
        "score": score,
        "box": box,
        "centroid": ((box[0] + box[2]) // 2, (box[1] + box[3]) // 2),
        "area": (box[2] - box[0]) * (box[3] - box[1]),
        "ratio": 1.6,
        "region": (0, 0, 640, 360),
        "frame_time": when,
        "start_time": 1.0,
        "motionless_count": 0,
        "position_changes": 1,
        "attributes": [],
        "estimate_velocity": np.zeros((2, 2)),
    }


def make_tracked_object(
    config: FrigateConfig, box=ROAD_BOX, score: float = 0.9, label="car"
) -> TrackedObject:
    first = detection(box, 1.0, score, label)
    first["score_history"] = [score]
    return TrackedObject(
        config.model_for_camera("front"), config.cameras["front"], config.ui, {}, first
    )


class TestExclusionHelpers(unittest.TestCase):
    def setUp(self):
        self.camera = make_config().cameras["front"]

    def test_names(self):
        self.assertEqual(exclusion_zone_names(self.camera.zones), {"far_road"})

    def test_object_only_in_the_exclusion_zone_is_excluded(self):
        obj = tracked(entered=["far_road"], current=["far_road"])
        self.assertTrue(excluded_from_review(obj, self.camera))

    def test_object_that_walked_out_into_no_zone_is_reviewed(self):
        obj = tracked(entered=["far_road"], box=LAWN_BOX)
        self.assertFalse(excluded_from_review(obj, self.camera))

    def test_object_that_walked_from_exclusion_into_a_normal_zone_is_reviewed(self):
        obj = tracked(
            entered=["far_road", "driveway"], current=["driveway"], box=DRIVEWAY_BOX
        )
        self.assertFalse(excluded_from_review(obj, self.camera))

    def test_object_that_also_entered_a_normal_zone_is_reviewed(self):
        # back on the road after the driveway: it was of interest, so it stays
        obj = tracked(entered=["far_road", "driveway"], current=["far_road"])
        self.assertFalse(excluded_from_review(obj, self.camera))

    def test_object_outside_every_zone_is_reviewed(self):
        self.assertFalse(excluded_from_review(tracked(box=LAWN_BOX), self.camera))

    def test_object_still_building_inertia_inside_the_zone_is_excluded(self):
        # zone inertia keeps it out of entered_zones for its first frames
        self.assertTrue(excluded_from_review(tracked(), self.camera))

    def test_object_building_inertia_in_a_second_exclusion_zone_is_excluded(self):
        camera = make_config(verge=VERGE).cameras["front"]
        obj = tracked(entered=["far_road"], box=VERGE_BOX)
        self.assertTrue(excluded_from_review(obj, camera))

    def test_exclusion_for_other_labels_does_not_apply(self):
        camera = make_config(far_road={"objects": ["car"]}).cameras["front"]
        self.assertFalse(excluded_from_review(tracked(label="person"), camera))
        self.assertTrue(excluded_from_review(tracked(label="car"), camera))

    def test_disabled_exclusion_zone_is_ignored(self):
        camera = make_config(far_road={"enabled": False}).cameras["front"]
        obj = tracked(entered=["far_road"], current=["far_road"])
        self.assertFalse(excluded_from_review(obj, camera))

    def test_camera_without_exclusion_zones(self):
        camera = make_config(far_road={"exclusion": False}).cameras["front"]
        obj = tracked(entered=["far_road"], current=["far_road"])
        self.assertFalse(excluded_from_review(obj, camera))

    def test_crossing_a_line_makes_the_object_reviewable(self):
        camera = make_config(
            door={"type": "line", "coordinates": "0.5,0,0.5,1"}
        ).cameras["front"]
        obj = tracked(entered=["far_road", "door"], current=["far_road", "door"])
        self.assertFalse(excluded_from_review(obj, camera))


class TestActiveObjectsExclusion(unittest.TestCase):
    def setUp(self):
        self.camera = make_config().cameras["front"]

    def categorize(self, *objects) -> dict[str, list[dict[str, Any]]]:
        return ActiveObjects(10.0, self.camera, list(objects)).categorized_objects

    def test_excluded_object_is_neither_alert_nor_detection(self):
        result = self.categorize(tracked(entered=["far_road"], current=["far_road"]))
        self.assertEqual(result, {"alerts": [], "detections": []})

    def test_normal_objects_still_alert(self):
        driveway = tracked(
            entered=["driveway"],
            current=["driveway"],
            box=DRIVEWAY_BOX,
            label="person",
            object_id="2.0-person",
        )
        lawn = tracked(box=LAWN_BOX, label="person", object_id="3.0-person")
        excluded = tracked(entered=["far_road"], current=["far_road"])
        left = tracked(
            entered=["far_road"], box=LAWN_BOX, label="person", object_id="4.0-person"
        )
        result = self.categorize(driveway, lawn, excluded, left)
        self.assertEqual(
            [o["id"] for o in result["alerts"]],
            ["2.0-person", "3.0-person", "4.0-person"],
        )


class TestReviewMaintainerExclusion(unittest.TestCase):
    def setUp(self):
        clips = tempfile.TemporaryDirectory()
        self.addCleanup(clips.cleanup)
        self.enterContext(patch.object(maintainer_module, "CLIPS_DIR", clips.name))
        for name in (
            "SharedMemoryFrameManager",
            "InterProcessRequestor",
            "CameraConfigUpdateSubscriber",
            "DetectionSubscriber",
            "ReviewDataPublisher",
        ):
            self.enterContext(patch.object(maintainer_module, name))
        self.config = make_config()
        self.maintainer = ReviewSegmentMaintainer(self.config, MagicMock())
        self.maintainer.frame_manager.get.return_value = np.zeros((540, 640), np.uint8)

    def test_subscribes_to_zone_updates(self):
        topics = maintainer_module.CameraConfigUpdateSubscriber.call_args.args[2]
        self.assertIn(maintainer_module.CameraConfigUpdateEnum.zones, topics)

    def test_excluded_object_never_starts_a_segment(self):
        obj = tracked(entered=["far_road"], current=["far_road"])
        self.maintainer.check_if_new_segment("front", "front-10", 10.0, [obj])
        self.assertIsNone(self.maintainer.active_review_segments.get("front"))

    def test_excluded_object_never_upgrades_a_detection(self):
        self.config.cameras["front"].review.alerts.labels = ["person"]
        car = tracked(
            entered=["driveway"],
            current=["driveway"],
            box=DRIVEWAY_BOX,
            object_id="2.0-car",
        )
        self.maintainer.check_if_new_segment("front", "front-10", 10.0, [car])
        segment = self.maintainer.active_review_segments["front"]
        self.assertEqual(segment.severity, SeverityEnum.detection)

        self.config.cameras["front"].review.alerts.labels = ["person", "car"]
        person = tracked(
            entered=["far_road"],
            current=["far_road"],
            label="person",
            object_id="3.0-person",
        )
        self.maintainer.update_existing_segment(segment, "front-11", 10.0, [person])
        self.assertEqual(segment.severity, SeverityEnum.detection)
        self.assertNotIn("3.0-person", segment.detections)

    def test_object_walking_in_is_reviewed_until_it_is_inside(self):
        # as on the real demo stack: a person first seen just below the far
        # road starts an alert, which stops counting them once they are inside
        below = tracked(box=(100, 110, 200, 150), label="person", object_id="4.0-p")
        self.maintainer.check_if_new_segment("front", "front-10", 10.0, [below])
        segment = self.maintainer.active_review_segments["front"]
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertIn("4.0-p", segment.detections)

        inside = tracked(
            entered=["far_road"],
            current=["far_road"],
            label="person",
            object_id="4.0-p",
        )
        inside["frame_time"] = 11.0
        self.maintainer.update_existing_segment(segment, "front-11", 11.0, [inside])
        self.assertEqual(segment.last_alert_time, 10.0)

        cutoff = self.config.cameras["front"].review.alerts.cutoff_time
        inside["frame_time"] = 11.0 + cutoff
        self.maintainer.update_existing_segment(
            segment, "front-12", 11.0 + cutoff, [inside]
        )
        self.assertIsNone(self.maintainer.active_review_segments["front"])
        self.assertEqual(segment.get_data(ended=True)["end_time"], 10.0)

    def test_tracked_object_that_walks_out_starts_an_alert(self):
        # the tracker's own output, frame by frame, as review receives it
        obj = make_tracked_object(self.config, label="person")
        for when in (2.0, 3.0, 4.0, 5.0):
            obj.update(when, detection(ROAD_BOX, when, label="person"), True)
            self.maintainer.check_if_new_segment(
                "front", f"front-{when}", when, [obj.to_dict()]
            )
        self.assertEqual(obj.entered_zones, ["far_road"])
        self.assertIsNone(self.maintainer.active_review_segments.get("front"))

        obj.update(6.0, detection(LAWN_BOX, 6.0, label="person"), True)
        self.maintainer.check_if_new_segment("front", "front-6", 6.0, [obj.to_dict()])
        segment = self.maintainer.active_review_segments["front"]
        self.assertEqual(segment.severity, SeverityEnum.alert)
        self.assertIn(obj.obj_data["id"], segment.detections)


class TestTrackedObjectSeverity(unittest.TestCase):
    def setUp(self):
        self.config = make_config()

    def walk(self, obj: TrackedObject, boxes, start: float = 2.0, score=0.9):
        for step, box in enumerate(boxes):
            when = start + step
            obj.update(when, detection(box, when, score), True)

    def test_only_seen_in_exclusion_zones_means_no_severity(self):
        obj = make_tracked_object(self.config)
        self.assertIsNone(obj.max_severity)
        self.walk(obj, [ROAD_BOX] * 4)
        self.assertEqual(obj.entered_zones, ["far_road"])
        self.assertIsNone(obj.max_severity)
        self.assertTrue(excluded_from_review(obj.to_dict(), obj.camera_config))

    def test_walking_out_into_no_zone_is_reviewed_and_kept(self):
        obj = make_tracked_object(self.config)
        self.walk(obj, [ROAD_BOX] * 4 + [LAWN_BOX])
        self.assertEqual(obj.current_zones, [])
        self.assertFalse(excluded_from_review(obj.to_dict(), obj.camera_config))
        self.assertEqual(obj.max_severity, SeverityEnum.alert)

        # back on the road it is out of review again, but its clip is kept
        self.walk(obj, [ROAD_BOX], start=7.0)
        self.assertEqual(obj.current_zones, ["far_road"])
        self.assertTrue(excluded_from_review(obj.to_dict(), obj.camera_config))
        self.assertEqual(obj.max_severity, SeverityEnum.alert)

    def test_walking_into_a_normal_zone_is_reviewed(self):
        obj = make_tracked_object(self.config)
        self.walk(obj, [ROAD_BOX] * 4 + [DRIVEWAY_BOX] * 3)
        self.assertEqual(obj.entered_zones, ["far_road", "driveway"])
        self.assertFalse(excluded_from_review(obj.to_dict(), obj.camera_config))
        self.assertEqual(obj.max_severity, SeverityEnum.alert)

    def test_never_in_a_zone_is_reviewed(self):
        obj = make_tracked_object(self.config, box=LAWN_BOX)
        self.walk(obj, [LAWN_BOX] * 3)
        self.assertEqual(obj.entered_zones, [])
        self.assertEqual(obj.max_severity, SeverityEnum.alert)

    def test_frames_as_a_false_positive_outside_do_not_count(self):
        # review skips false positives, so a low score on the lawn is not a
        # reviewed frame and the clip of a car that then sits on the road goes
        obj = make_tracked_object(self.config, box=LAWN_BOX, score=0.1)
        self.walk(obj, [LAWN_BOX], score=0.1)
        self.assertTrue(obj.false_positive)
        self.walk(obj, [ROAD_BOX] * 6, start=3.0)
        self.assertFalse(obj.false_positive)
        self.assertIsNone(obj.max_severity)

    def test_camera_without_exclusion_zones(self):
        obj = make_tracked_object(make_config(far_road={"exclusion": False}))
        self.walk(obj, [ROAD_BOX] * 4)
        self.assertEqual(obj.max_severity, SeverityEnum.alert)


if __name__ == "__main__":
    unittest.main()
