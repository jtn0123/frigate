"""Private runtime writes must not expose secrets or follow existing symlinks."""

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
