"""Test legacy Birdseye configuration migration."""

import unittest

from frigate.util.config import migrate_019_0


class TestBirdseyeMigration(unittest.TestCase):
    def test_global_camera_and_profile_modes_migrate(self):
        config = {
            "birdseye": {"mode": "objects", "enabled": True},
            "cameras": {
                "front": {
                    "birdseye": {"mode": "motion"},
                    "profiles": {"night": {"birdseye": {"mode": "continuous"}}},
                }
            },
        }
        result = migrate_019_0(config)
        self.assertEqual(
            result["birdseye"], {"modes": ["all_objects"], "enabled": True}
        )
        camera = result["cameras"]["front"]
        self.assertEqual(camera["birdseye"], {"modes": ["motion"]})
        self.assertEqual(
            camera["profiles"]["night"]["birdseye"], {"modes": ["continuous"]}
        )
        self.assertEqual(result["version"], "0.19-0")
        self.assertEqual(migrate_019_0(result), result)

    def test_new_empty_and_combined_modes_are_preserved(self):
        config = {
            "birdseye": {"modes": []},
            "cameras": {"front": {"birdseye": {"modes": ["alerts", "motion"]}}},
        }
        result = migrate_019_0(config)
        self.assertEqual(result["birdseye"], {"modes": []})
        self.assertEqual(
            result["cameras"]["front"]["birdseye"], {"modes": ["alerts", "motion"]}
        )
