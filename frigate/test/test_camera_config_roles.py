"""Camera deletion must retain valid built-in and shared authorization roles."""

import unittest

from frigate.api.camera_config import _remove_camera_roles


class TestCameraRemovalRoles(unittest.TestCase):
    def test_removes_empty_custom_roles_but_keeps_builtins_and_shared_roles(self):
        roles = {
            "admin": ["front"],
            "viewer": ["front"],
            "custom": ["front"],
            "shared": ["front", "back"],
            "unrelated": ["back"],
            "wildcard": "*",
        }
        data = {"auth": {"roles": roles}}
        _remove_camera_roles(data, "front")
        self.assertEqual(
            roles,
            {
                "admin": [],
                "viewer": [],
                "shared": ["back"],
                "unrelated": ["back"],
                "wildcard": "*",
            },
        )

    def test_no_roles_or_auth_is_unchanged(self):
        for data in [{}, {"auth": None}, {"auth": {}}, {"auth": {"enabled": True}}]:
            with self.subTest(data=data):
                expected = data.copy()
                _remove_camera_roles(data, "front")
                self.assertEqual(data, expected)
