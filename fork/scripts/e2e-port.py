"""Reserve a unique preview port across registered worktrees, or fail clearly."""

import argparse
import errno
import fcntl
import os
import socket
import subprocess
import tempfile
from collections.abc import Iterable
from pathlib import Path


def git(worktree: Path, *arguments: str) -> str:
    """Read Git's authoritative worktree inventory without scanning directories."""
    return subprocess.check_output(
        ["git", "-C", str(worktree), *arguments], text=True
    ).strip()


def port_number(value: str) -> int:
    """Reject empty, malformed and out-of-range port records."""
    if not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise ValueError(f"Invalid preview port: {value!r}")
    return int(value)


def available(port: int) -> bool:
    """Check IPv4 and IPv6 loopback listeners before reserving a port."""
    for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                # Match Node's bind behavior after a stopped preview served TCP.
                # TIME_WAIT is reusable, while an active listener still conflicts.
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind((address, port))
        except OSError as error:
            if family == socket.AF_INET6 and error.errno in (
                errno.EAFNOSUPPORT,
                errno.EADDRNOTAVAIL,
            ):
                continue
            return False
    return True


def reserve(
    worktree: Path, requested: int | None = None, start: int = 4190, end: int = 4299
) -> int:
    """Serialize allocation, honoring records even for previews that are stopped."""
    worktree = worktree.resolve()
    common = Path(
        git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
    )
    with (common / "e2e-ports.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        reserved = set()
        for line in git(worktree, "worktree", "list", "--porcelain").splitlines():
            if not line.startswith("worktree "):
                continue
            other = Path(line[len("worktree ") :]).resolve()
            record = other / "web/.e2e-port"
            if other != worktree and record.is_file():
                reserved.add(port_number(record.read_text().strip()))
        record = worktree / "web/.e2e-port"
        candidates: Iterable[int]
        if requested is not None:
            candidates = [port_number(str(requested))]
        elif record.is_file():
            previous = port_number(record.read_text().strip())
            candidates = (
                [previous] if previous not in reserved else range(start, end + 1)
            )
        else:
            candidates = range(start, end + 1)
        for port in candidates:
            if port in reserved or not available(port):
                continue
            record.parent.mkdir(parents=True, exist_ok=True)
            descriptor, name = tempfile.mkstemp(dir=record.parent)
            try:
                with os.fdopen(descriptor, "w") as output:
                    output.write(f"{port}\n")
                os.replace(name, record)
            finally:
                Path(name).unlink(missing_ok=True)
            return port
        raise RuntimeError(
            "No unique preview port is available. Stop the preview using the "
            "recorded port or set E2E_PORT to another unused port. "
            "An existing server will not be reused."
        )


def main() -> None:
    """Reserve the worktree's preview port and print only its number."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worktree", type=Path, default=Path.cwd())
    parser.add_argument("--requested", type=int)
    args = parser.parse_args()
    try:
        print(reserve(args.worktree, args.requested))
    except (ValueError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
