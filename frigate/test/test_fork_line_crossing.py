"""Fork (D75, D76): line zone geometry, debounce and tracked object entry."""

import unittest

import numpy as np

from frigate.config import FrigateConfig
from frigate.fork.line_crossing import (
    SIDE_A,
    SIDE_B,
    LineState,
    direction_allows,
    draw_fork_zone,
    line_zone_names,
    segments_intersect,
    side_of_line,
)
from frigate.review.maintainer import ActiveObjects
from frigate.review.types import SeverityEnum
from frigate.track.tracked_object import TrackedObject

# A vertical line down the middle of a 320x240 frame, drawn top to bottom.
# Looking from the first point to the second (down the frame), side A is on
# the walker's left, which is the right half of the image, and side B the
# left half.
LEFT = (80.0, 120.0)
RIGHT = (240.0, 120.0)
TOP = (160.0, 0.0)
BOTTOM = (160.0, 240.0)


def make_config(zones: dict) -> FrigateConfig:
    return FrigateConfig(
        **{
            "mqtt": {"enabled": False},
            "cameras": {
                "front": {
                    "ffmpeg": {
                        "inputs": [{"path": "rtsp://test/front", "roles": ["detect"]}]
                    },
                    "detect": {"width": 320, "height": 240, "fps": 5},
                    "objects": {"track": ["person", "car"]},
                    "zones": zones,
                }
            },
        }
    )


class TestSideOfLine(unittest.TestCase):
    def test_left_of_direction_is_side_a(self):
        # horizontal line drawn left to right: above is the walker's left
        self.assertEqual(side_of_line((0, 0), (10, 0), (5, -3)), SIDE_A)
        self.assertEqual(side_of_line((0, 0), (10, 0), (5, 3)), SIDE_B)

    def test_vertical_line_drawn_downward(self):
        self.assertEqual(side_of_line(TOP, BOTTOM, RIGHT), SIDE_A)
        self.assertEqual(side_of_line(TOP, BOTTOM, LEFT), SIDE_B)

    def test_point_on_the_line_has_no_side(self):
        self.assertEqual(side_of_line((0, 0), (10, 10), (5, 5)), 0)

    def test_scaling_an_axis_keeps_the_side(self):
        # relative and pixel coordinates must agree
        relative = side_of_line((0.5, 0), (0.5, 1), (0.25, 0.5))
        pixels = side_of_line((640, 0), (640, 720), (320, 360))
        self.assertEqual(relative, pixels)


class TestSegmentsIntersect(unittest.TestCase):
    def test_crossing_in_either_direction(self):
        self.assertTrue(segments_intersect(LEFT, RIGHT, TOP, BOTTOM))
        self.assertTrue(segments_intersect(RIGHT, LEFT, TOP, BOTTOM))

    def test_touching_an_endpoint_counts(self):
        self.assertTrue(segments_intersect((0, 0), (5, 5), (5, 5), (10, 0)))
        # a movement ending exactly on the line
        self.assertTrue(segments_intersect(LEFT, (160, 120), TOP, BOTTOM))

    def test_passing_beyond_the_end_does_not_cross(self):
        self.assertFalse(segments_intersect((80, 300), (240, 300), TOP, BOTTOM))

    def test_parallel_segments_never_meet(self):
        self.assertFalse(segments_intersect((0, 0), (10, 0), (0, 5), (10, 5)))

    def test_collinear_segments_meet_only_when_they_overlap(self):
        self.assertTrue(segments_intersect((0, 0), (10, 0), (5, 0), (15, 0)))
        self.assertFalse(segments_intersect((0, 0), (4, 0), (5, 0), (15, 0)))

    def test_no_movement(self):
        self.assertFalse(segments_intersect(LEFT, LEFT, TOP, BOTTOM))
        self.assertTrue(segments_intersect((160, 50), (160, 50), TOP, BOTTOM))


class TestLineState(unittest.TestCase):
    def feed(self, state: LineState, points, inertia=1) -> list[int]:
        return [state.update(TOP, BOTTOM, point, inertia) for point in points]

    def test_crossing_from_b_to_a(self):
        # from the left half (side B) to the right half (side A)
        self.assertEqual(self.feed(LineState(), [LEFT, RIGHT]), [0, SIDE_A])

    def test_crossing_from_a_to_b(self):
        self.assertEqual(self.feed(LineState(), [RIGHT, LEFT]), [0, SIDE_B])

    def test_first_position_never_counts(self):
        self.assertEqual(self.feed(LineState(), [RIGHT]), [0])

    def test_standing_still_never_counts(self):
        self.assertEqual(self.feed(LineState(), [LEFT] * 5), [0] * 5)

    def test_position_on_the_line_waits_for_a_side(self):
        on_line = (160.0, 120.0)
        self.assertEqual(
            self.feed(LineState(), [LEFT, on_line, on_line, RIGHT]), [0, 0, 0, SIDE_A]
        )

    def test_inertia_needs_frames_on_the_new_side(self):
        steps = self.feed(LineState(), [LEFT, RIGHT, (250, 120), (260, 120)], 3)
        self.assertEqual(steps, [0, 0, 0, SIDE_A])

    def test_jitter_back_across_is_not_a_crossing(self):
        steps = self.feed(
            LineState(), [LEFT, (165, 120), (155, 120), (166, 120), (150, 120)], 3
        )
        self.assertEqual(steps, [0, 0, 0, 0, 0])

    def test_walking_around_the_end_is_not_a_crossing(self):
        state = LineState()
        steps = self.feed(state, [(80, 300), (240, 300)])
        self.assertEqual(steps, [0, 0])
        # the side still moved, so coming back through the line counts once
        self.assertEqual(state.side, SIDE_A)
        self.assertEqual(self.feed(state, [LEFT]), [SIDE_B])

    def test_crossing_back_counts_again(self):
        steps = self.feed(LineState(), [LEFT, RIGHT, LEFT])
        self.assertEqual(steps, [0, SIDE_A, SIDE_B])


class TestDirectionAllows(unittest.TestCase):
    def test_both_allows_either_side(self):
        self.assertTrue(direction_allows("both", SIDE_A))
        self.assertTrue(direction_allows("both", SIDE_B))
        self.assertFalse(direction_allows("both", 0))

    def test_one_way(self):
        self.assertTrue(direction_allows("a_to_b", SIDE_B))
        self.assertFalse(direction_allows("a_to_b", SIDE_A))
        self.assertTrue(direction_allows("b_to_a", SIDE_A))
        self.assertFalse(direction_allows("b_to_a", SIDE_B))


class TestTrackedObjectLineZone(unittest.TestCase):
    def make_object(self, zones: dict, label="person") -> TrackedObject:
        self.config = make_config(zones)
        camera = self.config.cameras["front"]
        return TrackedObject(
            self.config.model_for_camera("front"),
            camera,
            self.config.ui,
            {},
            self.detection(0.0, LEFT[0], label),
        )

    def detection(self, when: float, x: float, label="person", area=2400) -> dict:
        box = (int(x) - 20, 40, int(x) + 20, 120)
        return {
            "id": "1.0-abc",
            "label": label,
            "score": 0.9,
            "score_history": [0.9, 0.9, 0.9],
            "box": box,
            "centroid": (int(x), 80),
            "area": area,
            "ratio": 0.5,
            "region": (0, 0, 320, 240),
            "frame_time": when,
            "start_time": 0.0,
            "motionless_count": 0,
            "position_changes": 1,
            "attributes": [],
            "estimate_velocity": np.zeros((2, 2)),
        }

    def walk(self, obj: TrackedObject, xs, **kwargs) -> None:
        for step, x in enumerate(xs, start=1):
            when = float(step)
            obj.update(when, self.detection(when, x, **kwargs), True)

    def line(self, **extra) -> dict:
        return {
            "door": {"type": "line", "coordinates": "0.5,0,0.5,1", "inertia": 1} | extra
        }

    def test_crossing_adds_the_line_to_entered_and_current_zones(self):
        obj = self.make_object(self.line())
        self.walk(obj, [80, 120, 200, 240])
        self.assertEqual(obj.entered_zones, ["door"])
        self.assertEqual(obj.current_zones, ["door"])
        self.assertTrue(obj.new_zone_entered)

    def test_line_is_current_only_briefly_after_the_crossing(self):
        # zone occupancy is a pulse, so a car parked past the line is not on it
        obj = self.make_object(self.line())
        current = []
        for step, x in enumerate([80, 200, 210, 220, 230, 240, 250], start=1):
            when = step * 0.5
            obj.update(when, self.detection(when, x), True)
            current.append("door" in obj.current_zones)
        # crossed at 1 s, so the line is current until 3 s
        self.assertEqual(current, [False, True, True, True, True, False, False])
        self.assertEqual(obj.entered_zones, ["door"])

    def test_each_counted_crossing_is_current_again(self):
        obj = self.make_object(self.line())
        self.walk(obj, [80, 200, 240, 260, 280, 100])
        self.assertEqual(obj.entered_zones, ["door"])
        self.assertEqual(obj.current_zones, ["door"])

    def test_crossing_back_the_wrong_way_is_not_current(self):
        obj = self.make_object(self.line(direction="b_to_a"))
        self.walk(obj, [80, 200, 240, 260, 280, 100])
        self.assertEqual(obj.entered_zones, ["door"])
        self.assertEqual(obj.current_zones, [])

    def test_review_required_zones_see_the_crossing(self):
        obj = self.make_object(self.line())
        camera = obj.camera_config
        camera.review.alerts.required_zones = ["door"]

        def severity(when: float, x: float) -> str | None:
            obj.update(when, self.detection(when, x), True)
            found = ActiveObjects(when, camera, [obj.to_dict()]).categorized_objects
            return next((name for name, objs in found.items() if objs), None)

        self.assertEqual(severity(1.0, 80), "detections")
        self.assertEqual(severity(2.0, 200), "alerts")
        self.assertEqual(severity(3.0, 240), "alerts")
        self.assertEqual(severity(4.0, 260), "detections")

    def test_no_crossing_leaves_zones_empty(self):
        obj = self.make_object(self.line())
        self.walk(obj, [80, 100, 120, 140])
        self.assertEqual(obj.entered_zones, [])
        self.assertEqual(obj.current_zones, [])

    def test_wrong_direction_does_not_enter(self):
        # left half is side B, so walking right is B to A
        obj = self.make_object(self.line(direction="a_to_b"))
        self.walk(obj, [80, 200, 240])
        self.assertEqual(obj.entered_zones, [])

    def test_allowed_direction_enters(self):
        obj = self.make_object(self.line(direction="b_to_a"))
        self.walk(obj, [80, 200, 240])
        self.assertEqual(obj.entered_zones, ["door"])

    def test_one_way_line_counts_the_return_trip(self):
        obj = self.make_object(self.line(direction="a_to_b"))
        self.walk(obj, [80, 200, 240, 100])
        self.assertEqual(obj.entered_zones, ["door"])

    def test_inertia_debounces_a_brief_step_across(self):
        obj = self.make_object(self.line(inertia=3))
        self.walk(obj, [150, 170, 150, 170, 150])
        self.assertEqual(obj.entered_zones, [])

    def test_line_for_other_objects_is_ignored(self):
        obj = self.make_object(self.line(objects=["car"]))
        self.walk(obj, [80, 200, 240])
        self.assertEqual(obj.entered_zones, [])

    def test_zone_filters_apply_at_the_crossing(self):
        obj = self.make_object(self.line(filters={"person": {"min_area": 5000}}))
        self.walk(obj, [80, 200, 240])
        self.assertEqual(obj.entered_zones, [])

    def test_disabled_line_is_ignored(self):
        obj = self.make_object(self.line(enabled=False))
        self.walk(obj, [80, 200, 240])
        self.assertEqual(obj.entered_zones, [])

    def test_line_does_not_disturb_polygon_zones(self):
        zones = self.line() | {
            "porch": {"coordinates": "0.5,0,1,0,1,1,0.5,1", "inertia": 1}
        }
        obj = self.make_object(zones)
        self.walk(obj, [80, 200, 240])
        self.assertEqual(sorted(obj.entered_zones), ["door", "porch"])

    def test_line_counts_for_required_zones(self):
        obj = self.make_object(self.line())
        obj.camera_config.review.alerts.required_zones = ["door"]
        self.assertEqual(obj.max_severity, SeverityEnum.detection)
        self.walk(obj, [80, 200])
        self.assertEqual(obj.max_severity, SeverityEnum.alert)


class TestDrawForkZone(unittest.TestCase):
    def setUp(self):
        self.config = make_config(
            {
                "door": {"type": "line", "coordinates": "0.5,0,0.5,1"},
                "road": {
                    "coordinates": "0,0,0.5,0,0.5,0.5,0,0.5",
                    "exclusion": True,
                },
                "porch": {"coordinates": "0.5,0.5,1,0.5,1,1,0.5,1"},
            }
        )
        self.zones = self.config.cameras["front"].zones

    def test_line_and_exclusion_are_drawn_here(self):
        for direction in ("both", "a_to_b", "b_to_a"):
            frame = np.zeros((240, 320, 3), np.uint8)
            self.zones["door"].direction = direction
            self.assertTrue(draw_fork_zone(frame, self.zones["door"], 2))
            self.assertGreater(frame.sum(), 0)

        frame = np.zeros((240, 320, 3), np.uint8)
        self.assertTrue(draw_fork_zone(frame, self.zones["road"], 2))
        # the hatch paints inside the zone, not only its outline
        self.assertGreater(frame[20:100, 20:140].sum(), 0)

    def test_polygon_is_left_to_upstream(self):
        frame = np.zeros((240, 320, 3), np.uint8)
        self.assertFalse(draw_fork_zone(frame, self.zones["porch"], 2))
        self.assertEqual(frame.sum(), 0)

    def test_line_zone_names(self):
        self.assertEqual(line_zone_names(self.zones), ["door"])


if __name__ == "__main__":
    unittest.main()
