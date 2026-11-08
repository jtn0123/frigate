"""The startup config migration never leaves the file empty for a reader (B49)."""

import builtins
import errno
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ruamel.yaml import YAML

import frigate.util.config as config_util
from frigate.fork.config_persistence import write_migrated_config
from frigate.util.config import migrate_frigate_config


def migration_yaml() -> YAML:
    yaml = YAML()
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


class TestWriteMigratedConfig(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "config.yml"
        self.path.write_text("version: 0.13\n")
        os.chmod(self.path, 0o640)

    def test_the_file_is_replaced_in_one_step(self) -> None:
        before = self.path.stat()

        write_migrated_config(
            str(self.path), migration_yaml(), {"version": "0.14", "cameras": {}}
        )

        after = self.path.stat()
        # a rename gives the path a new file: a reader sees the old or the new
        self.assertNotEqual(after.st_ino, before.st_ino)
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o640)
        self.assertEqual(self.path.read_text(), "version: '0.14'\ncameras: {}\n")
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["config.yml"])

    def test_a_mount_that_cannot_be_replaced_is_written_in_place(self) -> None:
        before = self.path.stat()
        busy = OSError(errno.EBUSY, "Device or resource busy")

        with patch("frigate.fork.config_persistence.os.replace", side_effect=busy):
            write_migrated_config(str(self.path), migration_yaml(), {"version": "0.14"})

        self.assertEqual(self.path.stat().st_ino, before.st_ino)
        self.assertEqual(self.path.read_text(), "version: '0.14'\n")
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["config.yml"])


class TestMigrationWrites(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config_file = os.path.join(directory.name, "config.yml")
        for name, value in (
            ("CONFIG_DIR", directory.name),
            ("EXPORT_DIR", os.path.join(directory.name, "exports")),
        ):
            patcher = patch.object(config_util, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_no_step_truncates_the_config_in_place(self) -> None:
        with open(self.config_file, "w") as f:
            f.write("mqtt:\n  host: mqtt\ncameras: {}\n")
        real_open = builtins.open
        config_path = os.path.realpath(self.config_file)

        def guarded_open(file, mode="r", *args, **kwargs):
            if "w" in mode and os.path.realpath(file) == config_path:
                raise AssertionError("the config was opened for an in-place write")
            return real_open(file, mode, *args, **kwargs)

        with patch("builtins.open", guarded_open):
            migrate_frigate_config(self.config_file)

        with open(self.config_file) as f:
            migrated = YAML().load(f)
        self.assertEqual(migrated["mqtt"], {"host": "mqtt"})
        self.assertNotEqual(str(migrated["version"]), "0.13")


if __name__ == "__main__":
    unittest.main()
