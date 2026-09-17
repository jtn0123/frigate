"""Fork (SV8): report /dev/shm's size even when statvfs answers with zeros.

`calculate_shm_requirements` reads `/dev/shm` with `shutil.disk_usage`, which
is `statvfs`. On the owner's server, Frigate in Docker inside an unprivileged
Proxmox LXC, the API reported the `/dev/shm` totals as 0 even though `df`
inside the container showed 149 MiB used of 512 MiB, so the System page drew an
empty bar and the "shm is below the minimum" warning fired on a size nobody
could see.

The exact cause is not reproducible off that host (nested user namespaces and
`statvfs` on a tmpfs are the suspects), so this reads the mount's `size=`
option out of `/proc/self/mounts` whenever `statvfs` reports no total at all,
and measures what is in the directory for the used figure. Both are the same
numbers `df` shows. When neither says anything, the caller reports nothing
rather than zero.
"""

import logging
import os
import shutil
from typing import NamedTuple

logger = logging.getLogger(__name__)

SHM_PATH = "/dev/shm"
MOUNT_FILES = ("/proc/self/mounts", "/proc/mounts")

# tmpfs writes its size option as "size=524288k"; the kernel also accepts the
# other suffixes, and a bare byte count.
SIZE_SUFFIXES = {"k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}


class ShmUsage(NamedTuple):
    total: int
    used: int
    free: int


def parse_size_option(option: str) -> int | None:
    """Bytes for one `size=...` mount option, or None when it is not one."""
    if not option.startswith("size="):
        return None

    value = option[len("size=") :].strip().lower()

    if not value:
        return None

    multiplier = SIZE_SUFFIXES.get(value[-1])

    if multiplier is not None:
        value = value[:-1]
    else:
        multiplier = 1

    try:
        size = int(value)
    except ValueError:
        return None

    return size * multiplier if size > 0 else None


def parse_mount_total(content: str, path: str) -> int | None:
    """The size of the last mount on `path` in a /proc/mounts style table."""
    total = None

    for line in content.splitlines():
        fields = line.split()

        if len(fields) < 4:
            continue

        # The mount point is escaped the way getmntent writes it.
        mount_point = fields[1].replace("\\040", " ").replace("\\011", "\t")

        if mount_point != path:
            continue

        for option in fields[3].split(","):
            size = parse_size_option(option)

            if size is not None:
                total = size

    return total


def read_mount_total(path: str = SHM_PATH, mount_files: tuple[str, ...] = MOUNT_FILES):
    """The mounted size of `path` from /proc, or None when it is not there."""
    for mount_file in mount_files:
        try:
            with open(mount_file) as handle:
                content = handle.read()
        except OSError:
            continue

        total = parse_mount_total(content, path)

        if total is not None:
            return total

    return None


def directory_usage(path: str) -> int:
    """Bytes held by the files under `path`, the way df counts a tmpfs."""
    used = 0
    stack = [path]

    while stack:
        current = stack.pop()

        try:
            entries = list(os.scandir(current))
        except OSError:
            continue

        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                else:
                    used += entry.stat(follow_symlinks=False).st_size
            except OSError:
                # A frame can be unlinked while this walks the directory.
                continue

    return used


def shm_usage(path: str = SHM_PATH) -> ShmUsage | None:
    """Total, used and free bytes for a tmpfs, or None when nothing knows."""
    try:
        stats = shutil.disk_usage(path)
    except OSError:
        stats = None

    if stats is not None and stats.total > 0:
        return ShmUsage(stats.total, stats.used, stats.free)

    total = read_mount_total(path)

    if not total:
        logger.debug("Neither statvfs nor /proc knows the size of %s", path)
        return None

    used = stats.used if stats is not None and stats.used > 0 else directory_usage(path)
    used = min(used, total)
    logger.debug(
        "statvfs reported no size for %s; using the mount's %d bytes", path, total
    )
    return ShmUsage(total, used, total - used)
