"""Camera deletion must retain valid built-in and shared authorization roles."""

import unittest
from io import StringIO

from ruamel.yaml import YAML

from frigate.api.camera_config import _remove_camera_entry, _remove_camera_roles


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


class TestCameraRemovalEntry(unittest.TestCase):
    def _remove(self, text: str, camera_name: str):
        yaml = YAML()
        yaml.indent(mapping=2, sequence=4, offset=2)
        data = yaml.load(text)
        _remove_camera_entry(data, camera_name)
        out = StringIO()
        yaml.dump(data, out)
        return YAML(typ="safe").load(out.getvalue())

    def test_delete_only_camera_with_comment_on_cameras_key(self):
        # The default config ships a trailing comment on the cameras key
        data = self._remove(
            "cameras: # No cameras defined, UI wizard should be used\n"
            "  cam1:\n"
            "    enabled: true\n"
            "version: 0.18-0\n",
            "cam1",
        )
        self.assertEqual(data["cameras"], {})
        self.assertEqual(data["version"], "0.18-0")

    def test_delete_one_of_several_cameras_keeps_the_rest(self):
        data = self._remove(
            "cameras: # managed in the UI\n"
            "  cam1:\n"
            "    enabled: true\n"
            "  cam2:\n"
            "    enabled: false\n",
            "cam1",
        )
        self.assertEqual(data["cameras"], {"cam2": {"enabled": False}})

    def test_missing_camera_is_unchanged(self):
        data = self._remove("cameras:\n  cam1:\n    enabled: true\n", "nope")
        self.assertEqual(data["cameras"], {"cam1": {"enabled": True}})
