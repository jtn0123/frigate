"""Regression tests for durable configuration saves."""

import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate.api.app import config_save, config_set
from frigate.api.defs.request.app_body import AppConfigSetBody
from frigate.fork.config_persistence import config_file_lock, write_config_file
from frigate.util.builtin import update_yaml_file_bulk


class PartialWriter:
    """Simulate a filesystem write that fails after modifying its file."""

    def __init__(self, file):
        self.file = file

    def write(self, text):
        self.file.write(text[:12])
        self.file.flush()
        raise OSError("injected incomplete write")

    def __getattr__(self, name):
        return getattr(self.file, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.file.close()


class TestConfigPersistence(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "config.yml"
        self.original = (
            "mqtt:\n  enabled: false\ncameras: {}\nlogger:\n  default: info\n"
        )
        self.path.write_text(self.original)
        self.request = SimpleNamespace(
            url="http://test/api/config/set",
            app=SimpleNamespace(dispatcher=Mock(), frigate_config=Mock()),
        )
        finder = patch("frigate.api.app.find_config_file", return_value=str(self.path))
        finder.start()
        self.addCleanup(finder.stop)

    def failing_open(self, file, mode="r", *args, **kwargs):
        opened = self.real_open(file, mode, *args, **kwargs)
        return PartialWriter(opened) if "w" in mode else opened

    def test_raw_save_preserves_previous_config_after_partial_write(self):
        self.real_open = open
        with (
            patch("builtins.open", side_effect=self.failing_open),
            patch("io.open", side_effect=self.failing_open),
        ):
            response = config_save(
                "save", self.original.replace("info", "debug").encode()
            )
        self.assertGreaterEqual(response.status_code, 400)
        self.assertEqual(self.path.read_text(), self.original)

    def test_structured_save_preserves_previous_config_after_partial_write(self):
        self.real_open = open
        with (
            patch("builtins.open", side_effect=self.failing_open),
            patch("io.open", side_effect=self.failing_open),
        ):
            response = config_set(
                self.request,
                AppConfigSetBody(config_data={"logger": {"default": "debug"}}),
            )
        self.assertGreaterEqual(response.status_code, 400)
        self.assertEqual(self.path.read_text(), self.original)
        self.request.app.dispatcher.clear_runtime_state_for_yaml_keys.assert_not_called()

    def test_invalid_structured_candidate_is_never_written(self):
        writes = []
        real_open = open

        def recording_open(file, mode="r", *args, **kwargs):
            if "w" in mode:
                writes.append(file)
            return real_open(file, mode, *args, **kwargs)

        with (
            patch("builtins.open", side_effect=recording_open),
            patch("io.open", side_effect=recording_open),
        ):
            response = config_set(
                self.request,
                AppConfigSetBody(config_data={"logger": {"default": "invalid-level"}}),
            )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(json.loads(response.body)["success"])
        self.assertEqual(self.path.read_text(), self.original)
        self.assertEqual(writes, [])

    def test_failed_replace_preserves_previous_file_and_removes_temporary(self):
        with (
            config_file_lock(str(self.path)),
            patch("frigate.fork.config_persistence.os.replace", side_effect=OSError),
            self.assertRaises(OSError),
        ):
            write_config_file(str(self.path), "new config")
        self.assertEqual(self.path.read_text(), self.original)
        self.assertEqual(
            sorted(p.name for p in self.path.parent.iterdir()),
            ["config.yml", "config.yml.lock"],
        )

    def test_success_preserves_file_permissions_and_owner(self):
        self.path.chmod(0o640)
        previous = self.path.stat()
        with config_file_lock(str(self.path)):
            write_config_file(str(self.path), self.original.replace("info", "debug"))
        current = self.path.stat()
        self.assertEqual(current.st_mode & 0o777, 0o640)
        self.assertEqual(
            (current.st_uid, current.st_gid), (previous.st_uid, previous.st_gid)
        )
        self.assertIn("debug", self.path.read_text())

    def test_new_file_is_private(self):
        path = self.path.parent / "new.yml"
        with config_file_lock(str(path)):
            write_config_file(str(path), self.original)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_save_keeps_alias_and_locks_the_target(self):
        alias = self.path.parent / "alias.yml"
        alias.symlink_to(self.path)
        self.assertEqual(
            config_file_lock(str(alias)).lock_file,
            config_file_lock(str(self.path)).lock_file,
        )
        with config_file_lock(str(alias)):
            write_config_file(str(alias), self.original.replace("info", "debug"))
        self.assertTrue(alias.is_symlink())
        self.assertIn("debug", self.path.read_text())

    def test_raw_and_bulk_saves_wait_for_the_structured_save_lock(self):
        started = [Event(), Event()]

        def raw_save():
            started[0].set()
            return config_save("save", self.original.encode())

        def bulk_save():
            started[1].set()
            update_yaml_file_bulk(str(self.path), {"logger.default": "debug"})

        with ThreadPoolExecutor(max_workers=2) as executor:
            with config_file_lock(str(self.path)):
                raw = executor.submit(raw_save)
                bulk = executor.submit(bulk_save)
                for event in started:
                    self.assertTrue(event.wait(1))
                # Neither writer may finish while a structured save holds the lock.
                self.assertFalse(raw.done())
                self.assertFalse(bulk.done())
                self.assertEqual(self.path.read_text(), self.original)
            self.assertEqual(raw.result(timeout=2).status_code, 200)
            bulk.result(timeout=2)
        self.assertTrue(os.path.getsize(self.path) > 12)
