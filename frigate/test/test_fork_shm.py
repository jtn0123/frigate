"""Fork (SV8): /dev/shm size reporting when statvfs answers with zeros."""

import os
import tempfile
import unittest
from collections import namedtuple
from unittest.mock import patch

from frigate.util.fork_shm import (
    SHM_PATH,
    ShmUsage,
    directory_usage,
    parse_mount_total,
    parse_size_option,
    read_mount_total,
    shm_usage,
)

# What shutil.disk_usage returns, without depending on its private type.
DiskUsage = namedtuple("DiskUsage", ["total", "used", "free"])

MOUNTS = """\
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
tmpfs /dev tmpfs rw,nosuid,size=65536k,mode=755 0 0
shm /dev/shm tmpfs rw,nosuid,nodev,noexec,relatime,size=524288k 0 0
/dev/sda1 /media/frigate ext4 rw,relatime 0 0
"""


class TestSizeOption(unittest.TestCase):
    def test_reads_the_suffixes_tmpfs_writes(self):
        self.assertEqual(parse_size_option("size=524288k"), 524288 * 1024)
        self.assertEqual(parse_size_option("size=512M"), 512 * 1024**2)
        self.assertEqual(parse_size_option("size=2g"), 2 * 1024**3)
        self.assertEqual(parse_size_option("size=1048576"), 1048576)

    def test_rejects_anything_else(self):
        self.assertIsNone(parse_size_option("mode=755"))
        self.assertIsNone(parse_size_option("size="))
        self.assertIsNone(parse_size_option("size=lots"))
        self.assertIsNone(parse_size_option("size=0"))


class TestMountTable(unittest.TestCase):
    def test_finds_the_mount_for_the_path(self):
        self.assertEqual(parse_mount_total(MOUNTS, "/dev/shm"), 524288 * 1024)
        self.assertEqual(parse_mount_total(MOUNTS, "/dev"), 65536 * 1024)

    def test_no_size_option_and_no_mount(self):
        self.assertIsNone(parse_mount_total(MOUNTS, "/media/frigate"))
        self.assertIsNone(parse_mount_total(MOUNTS, "/dev/shmm"))
        self.assertIsNone(parse_mount_total("garbage\n", "/dev/shm"))

    def test_the_last_mount_on_a_path_wins(self):
        remounted = MOUNTS + "shm /dev/shm tmpfs rw,size=1024000k 0 0\n"
        self.assertEqual(parse_mount_total(remounted, "/dev/shm"), 1024000 * 1024)

    def test_reads_the_first_readable_proc_file(self):
        with tempfile.TemporaryDirectory() as directory:
            mounts = os.path.join(directory, "mounts")

            with open(mounts, "w") as handle:
                handle.write(MOUNTS)

            missing = os.path.join(directory, "absent")
            self.assertEqual(
                read_mount_total("/dev/shm", (missing, mounts)), 524288 * 1024
            )
            self.assertIsNone(read_mount_total("/dev/shm", (missing,)))


class TestDirectoryUsage(unittest.TestCase):
    def test_adds_up_the_files_below_the_path(self):
        with tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(directory, "frame"), "wb") as handle:
                handle.write(b"x" * 100)

            nested = os.path.join(directory, "nested")
            os.mkdir(nested)

            with open(os.path.join(nested, "frame"), "wb") as handle:
                handle.write(b"x" * 50)

            self.assertEqual(directory_usage(directory), 150)

    def test_an_unreadable_path_counts_as_nothing(self):
        self.assertEqual(directory_usage("/definitely/not/here"), 0)


class TestShmUsage(unittest.TestCase):
    def test_uses_statvfs_when_it_has_an_answer(self):
        usage = DiskUsage(total=512, used=100, free=412)

        with patch("frigate.util.fork_shm.shutil.disk_usage", return_value=usage):
            self.assertEqual(shm_usage("/dev/shm"), ShmUsage(512, 100, 412))

    def test_falls_back_to_the_mount_size_when_statvfs_reports_nothing(self):
        """The owner's server reports the /dev/shm totals as 0 (SV8)."""
        usage = DiskUsage(total=0, used=0, free=0)

        with (
            patch("frigate.util.fork_shm.shutil.disk_usage", return_value=usage),
            patch("frigate.util.fork_shm.read_mount_total", return_value=1024),
            patch("frigate.util.fork_shm.directory_usage", return_value=300),
        ):
            self.assertEqual(shm_usage("/dev/shm"), ShmUsage(1024, 300, 724))

    def test_keeps_the_used_figure_statvfs_did_give(self):
        usage = DiskUsage(total=0, used=200, free=0)

        with (
            patch("frigate.util.fork_shm.shutil.disk_usage", return_value=usage),
            patch("frigate.util.fork_shm.read_mount_total", return_value=1024),
        ):
            self.assertEqual(shm_usage("/dev/shm"), ShmUsage(1024, 200, 824))

    def test_used_never_exceeds_the_mounted_size(self):
        usage = DiskUsage(total=0, used=0, free=0)

        with (
            patch("frigate.util.fork_shm.shutil.disk_usage", return_value=usage),
            patch("frigate.util.fork_shm.read_mount_total", return_value=1024),
            patch("frigate.util.fork_shm.directory_usage", return_value=4096),
        ):
            self.assertEqual(shm_usage("/dev/shm"), ShmUsage(1024, 1024, 0))

    def test_falls_back_when_statvfs_raises(self):
        with (
            patch("frigate.util.fork_shm.shutil.disk_usage", side_effect=OSError),
            patch("frigate.util.fork_shm.read_mount_total", return_value=2048),
            patch("frigate.util.fork_shm.directory_usage", return_value=0),
        ):
            self.assertEqual(shm_usage("/dev/shm"), ShmUsage(2048, 0, 2048))

    def test_nothing_is_reported_when_nothing_knows(self):
        usage = DiskUsage(total=0, used=0, free=0)

        with (
            patch("frigate.util.fork_shm.shutil.disk_usage", return_value=usage),
            patch("frigate.util.fork_shm.read_mount_total", return_value=None),
        ):
            self.assertIsNone(shm_usage("/dev/shm"))


if __name__ == "__main__":
    unittest.main()


class TestShmPath(unittest.TestCase):
    def test_shm_path_is_the_kernel_mount_point(self) -> None:
        self.assertEqual(SHM_PATH, "/dev/shm")
