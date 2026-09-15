"""Private runtime writes must not expose secrets or follow existing symlinks."""

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frigate.util.atomic import write_private_file


class TestPrivateRuntimeFile(unittest.TestCase):
    """Exercise real file permissions, replacement, and failure cleanup."""

    def test_replaces_symlink_without_changing_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "unrelated"
            target.write_text("preserve")
            path = root / "config"
            path.symlink_to(target)
            write_private_file(path, "private camera configuration")
            self.assertEqual(target.read_text(), "preserve")
            self.assertFalse(path.is_symlink())
            self.assertEqual(path.read_text(), "private camera configuration")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_replaces_existing_public_file_with_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("old")
            path.chmod(0o644)
            write_private_file(path, "new")
            self.assertEqual(path.read_text(), "new")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_failed_replace_preserves_previous_file_and_removes_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("old")
            with patch("frigate.util.atomic.os.replace", side_effect=OSError):
                with self.assertRaises(OSError):
                    write_private_file(path, "new")
            self.assertEqual(path.read_text(), "old")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_failed_file_sync_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("old")
            with patch("frigate.util.atomic.os.fsync", side_effect=OSError):
                with self.assertRaises(OSError):
                    write_private_file(path, "new")
            self.assertEqual(path.read_text(), "old")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_file_contents_and_directory_are_synced_before_return(self):
        synced = []
        real_fsync = os.fsync

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"

            def record_sync(descriptor):
                mode = os.fstat(descriptor).st_mode
                if stat.S_ISREG(mode):
                    self.assertEqual(os.fstat(descriptor).st_size, len("new"))
                    self.assertFalse(path.exists())
                    synced.append("file")
                else:
                    self.assertTrue(stat.S_ISDIR(mode))
                    self.assertEqual(path.read_text(), "new")
                    synced.append("directory")
                real_fsync(descriptor)

            with patch("frigate.util.atomic.os.fsync", side_effect=record_sync):
                write_private_file(path, "new")
            self.assertEqual(synced, ["file", "directory"])


class TestPrivateRuntimeDirectory(unittest.TestCase):
    """Shared cache files must remain inside a directory owned by the service."""

    def test_creates_and_secures_existing_directory(self):
        from frigate.util.atomic import ensure_private_directory

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache"
            ensure_private_directory(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            path.chmod(0o777)
            (path / "frame").write_text("existing frame")
            ensure_private_directory(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            self.assertEqual((path / "frame").read_text(), "existing frame")

    def test_rejects_symlink_without_changing_target_permissions(self):
        from frigate.util.atomic import ensure_private_directory

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.mkdir(mode=0o755)
            path = Path(directory) / "cache"
            path.symlink_to(target)
            with self.assertRaises(OSError):
                ensure_private_directory(path)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)

    def test_rejects_directory_owned_by_another_user(self):
        from frigate.util.atomic import ensure_private_directory

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache"
            path.mkdir(mode=0o755)
            with patch("frigate.util.atomic.os.geteuid", return_value=-1):
                # The prepare step logs this line, so it has to name both UIDs.
                with self.assertRaisesRegex(
                    PermissionError,
                    rf"{path} is owned by UID {os.getuid()}, not by UID -1",
                ):
                    ensure_private_directory(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
