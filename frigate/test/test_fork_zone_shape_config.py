"""Fork (D75, D76, D77): validation of line zones and exclusion zones."""

import unittest

from pydantic import ValidationError

from frigate.config import FrigateConfig
from frigate.config.camera.zone import ZoneConfig
from frigate.config.fork.zone_shape import count_points


def camera_config(zones: dict) -> FrigateConfig:
    return FrigateConfig(
        **{
            "mqtt": {"enabled": False},
            "cameras": {
                "front": {
                    "ffmpeg": {
                        "inputs": [{"path": "rtsp://test/front", "roles": ["detect"]}]
                    },
                    "detect": {"width": 1280, "height": 720, "fps": 5},
                    "zones": zones,
                }
            },
        }
    )


class TestZoneShapeDefaults(unittest.TestCase):
    def test_existing_zones_stay_polygons(self):
        zone = ZoneConfig(coordinates="0,0,1,0,1,1")
        self.assertEqual(zone.type, "polygon")
        self.assertEqual(zone.direction, "both")
        self.assertFalse(zone.exclusion)

    def test_count_points(self):
        self.assertEqual(count_points("0.1,0.2,0.3,0.4"), 2)
        self.assertEqual(count_points(["0.1,0.2", "0.3,0.4", "0.5,0.6"]), 3)
        self.assertEqual(count_points(""), 0)


class TestLineZoneValidation(unittest.TestCase):
    def test_two_point_line_is_valid(self):
        for coordinates in ("0.5,0,0.5,1", ["0.5,0", "0.5,1"]):
            zone = ZoneConfig(type="line", coordinates=coordinates, direction="a_to_b")
            self.assertEqual(zone.type, "line")
            self.assertEqual(zone.direction, "a_to_b")

    def test_line_needs_exactly_two_points(self):
        for coordinates in ("0.5,0", "0,0,1,0,1,1"):
            with self.assertRaisesRegex(ValidationError, "exactly 2 points"):
                ZoneConfig(type="line", coordinates=coordinates)

    def test_polygon_only_options_are_rejected_on_a_line(self):
        cases = {
            "distances": {"distances": "1,2,3,4"},
            "speed_threshold": {"speed_threshold": 5},
            "loitering_time": {"loitering_time": 4},
            "exclusion": {"exclusion": True},
        }
        for message, options in cases.items():
            with self.subTest(option=message):
                with self.assertRaisesRegex(ValidationError, message):
                    ZoneConfig(type="line", coordinates="0,0,1,1", **options)

    def test_direction_is_rejected_on_a_polygon(self):
        with self.assertRaisesRegex(ValidationError, "direction only applies"):
            ZoneConfig(coordinates="0,0,1,0,1,1", direction="a_to_b")

    def test_unknown_values_are_rejected(self):
        with self.assertRaises(ValidationError):
            ZoneConfig(type="circle", coordinates="0,0,1,0,1,1")
        with self.assertRaises(ValidationError):
            ZoneConfig(type="line", coordinates="0,0,1,1", direction="left")

    def test_line_contour_has_two_points_in_pixels(self):
        config = camera_config(
            {"door": {"type": "line", "coordinates": "0.5,0.25,0.5,0.75"}}
        )
        contour = config.cameras["front"].zones["door"].contour
        self.assertEqual(contour.tolist(), [[640, 180], [640, 540]])

    def test_line_can_be_a_required_zone(self):
        config = FrigateConfig(
            **{
                "mqtt": {"enabled": False},
                "cameras": {
                    "front": {
                        "ffmpeg": {
                            "inputs": [
                                {"path": "rtsp://test/front", "roles": ["detect"]}
                            ]
                        },
                        "detect": {"width": 1280, "height": 720, "fps": 5},
                        "zones": {
                            "door": {"type": "line", "coordinates": "0.5,0,0.5,1"}
                        },
                        "review": {"alerts": {"required_zones": ["door"]}},
                    }
                },
            }
        )
        self.assertEqual(config.cameras["front"].review.alerts.required_zones, ["door"])


class TestExclusionZoneValidation(unittest.TestCase):
    def test_polygon_can_be_an_exclusion_zone(self):
        config = camera_config(
            {"road": {"coordinates": "0,0,1,0,1,0.3,0,0.3", "exclusion": True}}
        )
        self.assertTrue(config.cameras["front"].zones["road"].exclusion)


if __name__ == "__main__":
    unittest.main()
