"""Fork (SV11): wait for a detect ffmpeg to exit without keeping its output.

`Popen.communicate()` stores everything the process writes to stdout until it
exits. Detect's ffmpeg writes raw frames there, and one that answers SIGTERM by
flushing a backlog (a timestamp jump makes it emit thousands of duplicate
frames) can write gigabytes in the 30 seconds the watchdog waits. On the
owner's server that grew one capture process past 11 GB until the kernel
killed it, and the camera stayed down for six days. `wait_discarding` reads the
same output and throws it away, so the wait costs one read buffer.
"""

import logging
import os
import subprocess as sp
import threading
import weakref
from typing import Any

logger = logging.getLogger(__name__)

READ_BYTES = 1 << 20
JOIN_SECONDS = 5

_drains: "weakref.WeakKeyDictionary[sp.Popen[Any], threading.Thread]" = (
    weakref.WeakKeyDictionary()
)
_lock = threading.Lock()


def _discard(fd: int) -> None:
    """Read `fd` to its end, keeping nothing, then close it."""
    try:
        while os.read(fd, READ_BYTES):
            pass
    except OSError:
        # the pipe went away under us, which also ends the output
        pass
    finally:
        os.close(fd)


def _start_drain(process: sp.Popen[Any]) -> threading.Thread | None:
    """Start the reader for this process once, however often it is waited on."""
    if process.stdout is None:
        return None
    with _lock:
        drain = _drains.get(process)
        if drain is not None:
            return drain
        try:
            # A duplicate, so closing the Popen's own pipe later cannot hand
            # this thread a recycled descriptor that belongs to the next ffmpeg.
            fd = os.dup(process.stdout.fileno())
        except (OSError, ValueError):
            # already closed: nothing left to read
            return None
        drain = threading.Thread(
            target=_discard, args=(fd,), name="ffmpeg-discard", daemon=True
        )
        drain.start()
        _drains[process] = drain
        return drain


def wait_discarding(process: sp.Popen[Any], timeout: float | None = None) -> int:
    """Wait for `process` to exit while discarding what it writes to stdout.

    A drop-in for `process.communicate(timeout=...)` where the output is not
    wanted. The reader keeps running across calls, so the usual terminate,
    wait, kill, wait sequence can call this twice.

    Args:
        process: The ffmpeg process, started with `stdout=PIPE`.
        timeout: Seconds to wait, or None to wait until it exits.

    Returns:
        The process's exit code.

    Raises:
        subprocess.TimeoutExpired: The process is still running after
            `timeout` seconds. Its output is still being discarded.
    """
    drain = _start_drain(process)
    code = process.wait(timeout=timeout)
    if drain is not None:
        # The pipe closes with the process, so this returns at once unless
        # something else inherited the pipe. The thread is a daemon either way.
        drain.join(JOIN_SECONDS)
        if drain.is_alive():
            logger.warning("ffmpeg exited but its output pipe is still open")
    return code
