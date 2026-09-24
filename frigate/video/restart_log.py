"""Fork (D11): track camera ffmpeg restarts with a reason, and keep the log
readable while a camera keeps restarting.

Upstream logs "The following ffmpeg logs include the last 100 lines prior to
exit." plus up to 100 ffmpeg lines at ERROR on every exit, so a camera in a bad
spell floods the log with the same block every minute, and afterwards nothing
says how often it happened or why. `RestartLog` classifies each exit (hardware
decoding, connection, stalled, other) from ffmpeg's last lines, keeps the last
24 hours in a list shared with the stats process (Camera Health shows it), and
logs the full ffmpeg output only the first time a given failure shows up in an
hour; repeats get one line with a count.
"""

import logging
import re
import time
from collections.abc import MutableSequence
from typing import Any

from frigate.video.hwaccel_fallback import hwaccel_failure_line

HISTORY_SECONDS = 24 * 3600
HISTORY_MAX = 200
REPEAT_WINDOW_SECONDS = 3600
# Fork (SV5): restarts of the same role and kind this close together are one
# incident, so a burst does not inflate the Camera Health counts.
COALESCE_WINDOW_SECONDS = 10

# ffmpeg messages that mean the input went away rather than the decoder failing.
CONNECTION_MARKERS: tuple[str, ...] = (
    "Connection refused",
    "Connection timed out",
    "Connection reset",
    "No route to host",
    "Network is unreachable",
    "timed out",
    "Error during demuxing",
    "method DESCRIBE failed",
    "Server returned",
    "Unauthorized",
    "End of file",
)

# "[hwdownload @ 0x55d0c8e0a940] " and "[vf#0:0 @ 0x...] " prefixes.
_PREFIX = re.compile(r"^\[[^\]]*@ 0x[0-9a-f]+\]\s*")
_VOLATILE = re.compile(r"0x[0-9a-f]+|\d+")


def _clean(line: str) -> str:
    return _PREFIX.sub("", line.strip())


def classify_exit(lines: list[str]) -> tuple[str, str]:
    """Return (kind, message) for an ffmpeg exit from its last log lines."""
    failure = hwaccel_failure_line(lines)
    if failure is not None:
        return "hwaccel", _clean(failure)
    for line in lines:
        if any(marker in line for marker in CONNECTION_MARKERS):
            return "connection", _clean(line)
    errors = [line for line in lines if "rror" in line or "Failed" in line]
    if errors:
        return "other", _clean(errors[0])
    if lines:
        return "other", _clean(lines[-1])
    return "other", "exited without any output"


class RestartLog:
    """Restart history and log throttling for one camera's ffmpeg processes."""

    def __init__(
        self,
        camera: str,
        logger: logging.Logger,
        history: MutableSequence[dict[str, Any]] | None = None,
    ) -> None:
        self.camera = camera
        self.logger = logger
        self.history = history if history is not None else []
        # signature -> (time the full output was last logged, repeats since)
        self._dumped: dict[tuple[str, str, str], tuple[float, int]] = {}

    def record(
        self, role: str, kind: str, message: str, now: float | None = None
    ) -> dict[str, Any]:
        """Add one restart to the shared history, dropping entries past 24 h.

        Fork (SV5): a restart that follows one of the same role and kind
        within `COALESCE_WINDOW_SECONDS` counts up that incident instead of
        adding another, so the history keeps one entry per stall rather than
        one per ffmpeg kill. The incident keeps the time and message of its
        first restart, and carries how many restarts it stands for in
        `count`.
        """
        now = time.time() if now is None else now
        last = self.history[-1] if self.history else None

        if (
            last is not None
            and last["role"] == role
            and last["kind"] == kind
            and 0 <= now - last["time"] <= COALESCE_WINDOW_SECONDS
        ):
            # The history may be a manager list, so replace the entry rather
            # than mutating the copy this read returned.
            event = {**last, "count": last.get("count", 1) + 1}
            self.history[-1] = event
            return event

        event = {
            "time": round(now, 1),
            "role": role,
            "kind": kind,
            "message": message,
            "count": 1,
        }
        # Fork (B7): one read and one write instead of a round trip per dropped
        # entry. Safe because one watchdog thread per camera owns its list.
        entries = [*self.history[:], event]
        start = max(0, len(entries) - HISTORY_MAX)
        while start < len(entries) and entries[start]["time"] < now - HISTORY_SECONDS:
            start += 1
        if start:
            self.history[:] = entries[start:]
        else:
            self.history.append(event)
        return event

    def note_exit(
        self,
        role: str,
        logpipe: Any,
        cause: str | None = None,
        now: float | None = None,
        lines: list[str] | None = None,
    ) -> dict[str, Any]:
        """Record one exit and log it; empties `logpipe` either way.

        `cause` is set when the watchdog stopped ffmpeg itself (no frames,
        fps limit); otherwise the reason comes from ffmpeg's own output.
        `lines` is the caller's snapshot of that output (B5), so an exit gets
        the same classification everywhere even if ffmpeg wrote more since;
        without it the pipe is read here.
        """
        now = time.time() if now is None else now
        if lines is None:
            lines = list(logpipe.deque.copy())
        if cause is not None:
            kind, message = "stalled", cause
        else:
            kind, message = classify_exit(lines)
        event = self.record(role, kind, message, now)

        # Fork (B7): a signature past the window would get its full output
        # again anyway, so drop it; messages vary and the dict only grew.
        self._dumped = {
            signature: dumped
            for signature, dumped in self._dumped.items()
            if now - dumped[0] < REPEAT_WINDOW_SECONDS
        }
        signature = (role, kind, _VOLATILE.sub("#", message))
        last = self._dumped.get(signature)
        if last is None or now - last[0] >= REPEAT_WINDOW_SECONDS:
            self._dumped[signature] = (now, 0)
            # LogPipe.dump prints the "last 100 lines" heading itself (D54).
            logpipe.dump()
        else:
            dumped_at, repeats = last[0], last[1] + 1
            self._dumped[signature] = (dumped_at, repeats)
            logpipe.deque.clear()
            # ffmpeg messages often already end in "."; don't add another.
            detail = message.removesuffix(".")
            self.logger.warning(
                f"{self.camera}: {role} ffmpeg exited again ({kind}: {detail}). "
                f"That is {repeats + 1} times since "
                f"{time.strftime('%H:%M:%S', time.localtime(dumped_at))}, when its "
                "full output was logged."
            )
        return event
