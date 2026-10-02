"""Coverage for the norfair object tracker (fork D73).

Drives NorfairTracker with a real CameraConfig and PTZMetrics through
several frames of synthetic detections, and exercises the position,
expiry, re-identification and debug helpers directly. Shared memory and
the PTZ motion estimator are mocked.
"""

import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.camera import PTZMetrics
from frigate.config import CameraConfig, FrigateConfig
from frigate.track import norfair_tracker as norfair_module
from frigate.track.norfair_tracker import NorfairTracker, histogram_distance
from frigate.track.stationary_classifier import StationaryThresholds

WIDTH, HEIGHT = 640, 360


def _camera_config(autotracking: bool = False, **detect: Any) -> CameraConfig:
    camera: dict[str, Any] = {
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
        },
        "detect": {"width": WIDTH, "height": HEIGHT, "fps": 5, **detect},
        "objects": {"track": ["person", "car", "license_plate", "dog"]},
        "zones": {"yard": {"coordinates": "0,0,640,0,640,360,0,360"}},
    }
    if autotracking:
        camera["onvif"] = {
            "host": "10.0.0.2",
            "autotracking": {
                "enabled": True,
                "track": ["person"],
                "required_zones": ["yard"],
            },
        }
    config = FrigateConfig(**{"mqtt": {"enabled": False}, "cameras": {"cam": camera}})
    return config.cameras["cam"]


def _det(
    label: str, box: tuple[int, int, int, int], score: float = 0.9
) -> tuple[Any, ...]:
    area = (box[2] - box[0]) * (box[3] - box[1])
    return (label, score, box, area, 1.0, (0, 0, WIDTH, HEIGHT))


class NorfairTestBase(unittest.TestCase):
    def setUp(self) -> None:
        frame_manager = patch.object(norfair_module, "SharedMemoryFrameManager")
        self.frame_manager_cls = frame_manager.start()
        self.addCleanup(frame_manager.stop)
        self.yuv = np.full((HEIGHT * 3 // 2, WIDTH), 128, dtype=np.uint8)
        self.frame_manager_cls.return_value.get.return_value = self.yuv

    def make_tracker(
        self, autotracking: bool = False, enabled: bool = False, **detect: Any
    ) -> NorfairTracker:
        metrics = PTZMetrics(autotracker_enabled=enabled)
        return NorfairTracker(_camera_config(autotracking, **detect), metrics)

    def run_frames(
        self,
        tracker: NorfairTracker,
        frames: list[list[tuple[Any, ...]]],
        start: float = 100.0,
    ) -> float:
        frame_time = start
        for detections in frames:
            frame_time += 0.2
            tracker.match_and_update(f"cam_frame{frame_time}", frame_time, detections)
        return frame_time


class TestConstruction(NorfairTestBase):
    def test_static_camera_trackers(self) -> None:
        tracker = self.make_tracker()
        self.assertEqual(set(tracker.trackers), {"car"})
        self.assertIsNone(tracker.ptz_motion_estimator)
        self.assertIs(tracker.get_tracker("car"), tracker.trackers["car"]["static"])
        self.assertIs(tracker.get_tracker("dog"), tracker.default_tracker["static"])

    def test_autotracking_camera_adds_reid_person_tracker(self) -> None:
        with patch.object(norfair_module, "PtzMotionEstimator") as estimator:
            tracker = self.make_tracker(autotracking=True, enabled=True)
        estimator.assert_called_once()
        self.assertIn("ptz", tracker.trackers["person"])
        person = tracker.get_tracker("person")
        self.assertIs(person, tracker.trackers["person"]["ptz"])
        # person has no stationary max_frames, so the reid settings are used
        self.assertEqual(person.reid_hit_counter_max, 10)
        # non person labels fall back to the static or default ptz tracker
        self.assertIs(tracker.get_tracker("dog"), tracker.default_tracker["static"])

    def test_max_frames_disables_reid(self) -> None:
        tracker = self.make_tracker(
            autotracking=True, stationary={"max_frames": {"default": 50}}
        )
        self.assertIsNone(tracker.trackers["person"]["ptz"].reid_hit_counter_max)


class TestMatchAndUpdate(NorfairTestBase):
    def test_objects_register_update_and_expire(self) -> None:
        tracker = self.make_tracker(min_initialized=2, max_disappeared=3)
        car = _det("car", (100, 100, 200, 160))
        dog = _det("dog", (400, 200, 450, 260))

        self.run_frames(tracker, [[car, dog]] * 4)

        labels = sorted(o["label"] for o in tracker.tracked_objects.values())
        self.assertEqual(labels, ["car", "dog"])
        car_obj = next(
            o for o in tracker.tracked_objects.values() if o["label"] == "car"
        )
        self.assertEqual(car_obj["centroid"], (150, 130))
        self.assertGreater(car_obj["motionless_count"], 0)
        self.assertEqual(tracker.untracked_object_boxes, [])
        self.assertEqual(len(tracker.positions), 2)

        # the dog leaves: it is marked disappeared, then dropped
        frame_time = self.run_frames(tracker, [[car]], start=101.0)
        dog_id = next(
            k for k, o in tracker.tracked_objects.items() if o["label"] == "dog"
        )
        self.assertEqual(tracker.disappeared[dog_id], 1)

        self.run_frames(tracker, [[car]] * 6, start=frame_time)
        self.assertEqual(
            [o["label"] for o in tracker.tracked_objects.values()], ["car"]
        )

    def test_update_frame_times_keeps_objects_alive(self) -> None:
        tracker = self.make_tracker(min_initialized=2, max_disappeared=5)
        car = _det("car", (100, 100, 200, 160))
        frame_time = self.run_frames(tracker, [[car]] * 3)
        before = dict(tracker.tracked_objects)

        tracker.update_frame_times("cam_frame", frame_time + 0.2)

        self.assertEqual(set(tracker.tracked_objects), set(before))
        obj = next(iter(tracker.tracked_objects.values()))
        self.assertEqual(obj["frame_time"], frame_time + 0.2)

    def test_moving_object_counts_position_changes(self) -> None:
        tracker = self.make_tracker(min_initialized=2, max_disappeared=5)
        frames = [
            [_det("dog", (10 + step * 40, 100, 60 + step * 40, 160))]
            for step in range(8)
        ]
        self.run_frames(tracker, frames)

        obj = next(iter(tracker.tracked_objects.values()))
        self.assertGreaterEqual(obj["position_changes"], 1)
        self.assertEqual(obj["motionless_count"], 0)

    def test_autotracker_enabled_uses_motion_estimator(self) -> None:
        with patch.object(norfair_module, "PtzMotionEstimator") as estimator_cls:
            tracker = self.make_tracker(
                autotracking=True, enabled=False, min_initialized=2
            )
            self.assertIsNone(tracker.ptz_motion_estimator)
            # enabled at runtime (for example over mqtt)
            tracker.ptz_metrics.autotracker_enabled.value = True
            estimator_cls.return_value.motion_estimator.return_value = None

            person = _det("person", (100, 50, 160, 250))
            self.run_frames(tracker, [[person]] * 3)

        estimator_cls.assert_called_once()
        self.assertEqual(estimator_cls.return_value.motion_estimator.call_count, 3)
        self.frame_manager_cls.return_value.get.assert_called()
        self.assertEqual(
            [o["label"] for o in tracker.tracked_objects.values()], ["person"]
        )


class TestRegisterAndExpiry(NorfairTestBase):
    def test_register_reuses_norfair_history(self) -> None:
        tracker = self.make_tracker()
        past = [
            SimpleNamespace(data={"score": 0.5, "box": (0, 0, 10, 10)}),
            SimpleNamespace(data={"score": 0.7, "box": (2, 2, 12, 12)}),
        ]
        tracker.default_tracker["static"].tracked_objects = [
            SimpleNamespace(global_id=7, past_detections=past)
        ]

        tracker.register(
            "7", {"label": "dog", "frame_time": 5.0, "box": (2, 2, 12, 12)}
        )

        obj_id = tracker.track_id_map["7"]
        self.assertTrue(obj_id.startswith("5.0-"))
        self.assertEqual(tracker.tracked_objects[obj_id]["score_history"], [0.5, 0.7])
        self.assertEqual(tracker.positions[obj_id]["xmins"], [0, 2])
        self.assertEqual(tracker.positions[obj_id]["xmax"], WIDTH)

    def test_is_expired_and_update_deregisters(self) -> None:
        tracker = self.make_tracker(
            stationary={"max_frames": {"objects": {"car": 2}}, "threshold": 1}
        )
        tracker.register(
            "1", {"label": "car", "frame_time": 1.0, "box": (10, 10, 50, 50)}
        )
        obj_id = tracker.track_id_map["1"]
        self.assertFalse(tracker.is_expired(obj_id))

        tracker.register(
            "2", {"label": "dog", "frame_time": 1.0, "box": (10, 10, 50, 50)}
        )
        # dog has no max_frames, so it never expires
        tracker.tracked_objects[tracker.track_id_map["2"]]["motionless_count"] = 99
        self.assertFalse(tracker.is_expired(tracker.track_id_map["2"]))

        thresholds = StationaryThresholds()
        for _ in range(5):
            if "1" not in tracker.track_id_map:
                break
            tracker.update(
                "1", {"box": (10, 10, 50, 50), "frame_time": 2.0}, thresholds, None
            )
        self.assertNotIn("1", tracker.track_id_map)
        self.assertNotIn(obj_id, tracker.tracked_objects)


class TestUpdatePosition(NorfairTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.tracker = self.make_tracker()
        self.tracker.register(
            "1", {"label": "car", "frame_time": 1.0, "box": (100, 100, 200, 200)}
        )
        self.obj_id = self.tracker.track_id_map["1"]
        self.thresholds = StationaryThresholds(max_stationary_history=6)
        # seed a stable position box
        self.tracker.positions[self.obj_id].update(
            {"xmin": 100, "ymin": 100, "xmax": 200, "ymax": 200}
        )

    def test_stable_box_accumulates_and_trims_history(self) -> None:
        for _ in range(12):
            self.assertTrue(
                self.tracker.update_position(
                    self.obj_id, [100, 100, 200, 200], False, self.thresholds, None
                )
            )
        self.assertEqual(len(self.tracker.stationary_box_history[self.obj_id]), 6)
        self.assertEqual(len(self.tracker.positions[self.obj_id]["xmins"]), 10)

    def test_jump_resets_position(self) -> None:
        moved = self.tracker.update_position(
            self.obj_id, [400, 250, 500, 350], False, self.thresholds, None
        )
        self.assertFalse(moved)
        self.assertEqual(self.tracker.positions[self.obj_id]["xmin"], 400)

    def test_stationary_jump_consults_classifier(self) -> None:
        classifier = MagicMock()
        classifier.anchor_crops = {}
        self.tracker.stationary_classifier = classifier
        history = self.tracker.stationary_box_history[self.obj_id]
        history.extend([[100, 100, 200, 200]] * 30)
        # keep enough history that the jump barely moves the average box, so
        # the anchor crop is established before the classifier is consulted
        self.thresholds = StationaryThresholds(max_stationary_history=50)

        classifier.evaluate.return_value = True
        self.assertTrue(
            self.tracker.update_position(
                self.obj_id, [400, 250, 500, 350], True, self.thresholds, self.yuv
            )
        )
        classifier.ensure_anchor.assert_called_once()

        classifier.evaluate.return_value = False
        self.assertFalse(
            self.tracker.update_position(
                self.obj_id, [400, 250, 500, 350], True, self.thresholds, self.yuv
            )
        )

    def test_median_drift_checks(self) -> None:
        # average iou stays above known_active but under the check threshold
        thresholds = StationaryThresholds(
            known_active_iou=0.0, stationary_check_iou=0.99, active_check_iou=0.99
        )
        self.tracker.positions[self.obj_id].update(
            {"xmin": 0, "ymin": 0, "xmax": 10, "ymax": 10}
        )
        classifier = MagicMock()
        # an anchor already exists, so no new one is captured
        classifier.anchor_crops = {self.obj_id: True}
        self.tracker.stationary_classifier = classifier

        classifier.evaluate.return_value = True
        self.assertTrue(
            self.tracker.update_position(
                self.obj_id, [110, 110, 210, 210], True, thresholds, self.yuv
            )
        )
        classifier.evaluate.return_value = False
        self.tracker.positions[self.obj_id].update(
            {"xmin": 0, "ymin": 0, "xmax": 10, "ymax": 10}
        )
        self.assertFalse(
            self.tracker.update_position(
                self.obj_id, [110, 110, 210, 210], True, thresholds, self.yuv
            )
        )
        self.tracker.positions[self.obj_id].update(
            {"xmin": 0, "ymin": 0, "xmax": 10, "ymax": 10}
        )
        self.assertFalse(
            self.tracker.update_position(
                self.obj_id, [110, 110, 210, 210], False, thresholds, None
            )
        )

    def test_update_after_move_from_stationary(self) -> None:
        obj = self.tracker.tracked_objects[self.obj_id]
        obj["motionless_count"] = 50
        obj["position_changes"] = 2
        classifier = MagicMock()
        classifier.anchor_crops = {}
        self.tracker.stationary_classifier = classifier

        self.tracker.update(
            "1",
            {"box": (400, 250, 500, 350), "frame_time": 3.0},
            self.thresholds,
            None,
        )

        self.assertEqual(obj["position_changes"], 3)
        self.assertEqual(obj["motionless_count"], 0)
        self.assertEqual(obj["frame_time"], 3.0)
        classifier.on_active.assert_called_once_with(self.obj_id)


def _hist(value: int) -> np.ndarray:
    hist = np.zeros((8, 1), dtype=np.float32)
    hist[value % 8] = 1.0
    hist[(value + 3) % 8] = 0.5
    return hist


class TestHistogramDistance(unittest.TestCase):
    def test_matching_histograms_return_distance(self) -> None:
        unmatched = SimpleNamespace(
            last_detection=SimpleNamespace(embedding=_hist(1)), past_detections=[]
        )
        matched = SimpleNamespace(
            past_detections=[
                SimpleNamespace(embedding=None),
                SimpleNamespace(embedding=_hist(1)),
            ]
        )
        self.assertAlmostEqual(histogram_distance(matched, unmatched), 0.0, places=5)

    def test_falls_back_to_past_embedding_or_returns_one(self) -> None:
        unmatched = SimpleNamespace(
            last_detection=SimpleNamespace(embedding=None),
            past_detections=[
                SimpleNamespace(embedding=_hist(2)),
                SimpleNamespace(embedding=None),
            ],
        )
        different = SimpleNamespace(
            past_detections=[SimpleNamespace(embedding=_hist(6))]
        )
        self.assertEqual(histogram_distance(different, unmatched), 1)

        empty = SimpleNamespace(
            last_detection=SimpleNamespace(embedding=None),
            past_detections=[SimpleNamespace(embedding=None)],
        )
        self.assertEqual(histogram_distance(different, empty), 1)


class TestDebugHelpers(NorfairTestBase):
    def test_print_objects_as_table(self) -> None:
        tracker = self.make_tracker()
        objs = [
            SimpleNamespace(
                id=1, age=3, hit_counter=2, last_distance=0.25, initializing_id=9
            ),
            SimpleNamespace(
                id=2, age=1, hit_counter=1, last_distance=None, initializing_id=10
            ),
        ]
        with (
            patch.object(norfair_module, "print") as rich_print,
            patch.object(norfair_module, "Console") as console,
            patch.object(norfair_module, "Table") as table,
        ):
            tracker.print_objects_as_table(objs)

        rich_print.assert_called_once()
        rows = [c.args for c in table.return_value.add_row.call_args_list]
        self.assertEqual(rows[0][3], "0.2500")
        self.assertEqual(rows[1][3], "N/A")
        console.return_value.print.assert_called_once_with(table.return_value)

    def test_debug_draw(self) -> None:
        tracker = self.make_tracker(min_initialized=2)
        self.run_frames(
            tracker,
            [[_det("car", (100, 100, 200, 160)), _det("dog", (300, 100, 350, 160))]]
            * 3,
        )
        frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)

        with (
            patch.object(norfair_module, "draw_boxes") as draw_boxes,
            patch.object(norfair_module, "Drawable") as drawable,
            patch.object(norfair_module.Drawer, "text", return_value=frame) as text,
        ):
            tracker.debug_draw(frame, 100.6)

        self.assertEqual(draw_boxes.call_count, 3)
        colors = [c.kwargs["color"] for c in draw_boxes.call_args_list]
        self.assertEqual(colors, ["green", "blue", "red"])
        self.assertEqual(drawable.call_count, 2)
        self.assertEqual(text.call_count, 2)


if __name__ == "__main__":
    unittest.main()
