"""Fork (D31): stop retrying a cached recording segment that keeps failing.

A segment whose conversion fails keeps its cached copy, so the next cycle can
retry it after a passing problem (a converter that could not start, a busy
disk). A segment that fails every time, with ffmpeg hanging until the timeout
or the final move raising, would otherwise be retried forever: each hang holds
up the segments of every camera for the whole timeout, and the camera's object
and audio info is only trimmed up to its oldest cached segment, so it grows
without bound. After `MAX_MOVE_ATTEMPTS` failures the segment is dropped.
"""

import logging
from collections.abc import Iterable

logger = logging.getLogger(__name__)

MAX_MOVE_ATTEMPTS = 3


class MoveFailures:
    """Counts the failed attempts to move each cached segment."""

    def __init__(self, limit: int = MAX_MOVE_ATTEMPTS) -> None:
        self.limit = limit
        self._counts: dict[str, int] = {}

    def failed(self, cache_path: str) -> bool:
        """Note a failed attempt; True once the segment should be dropped."""
        count = self._counts.get(cache_path, 0) + 1
        if count < self.limit:
            self._counts[cache_path] = count
            return False

        self._counts.pop(cache_path, None)
        logger.warning(
            "Dropping cached recording segment %s after %s failed attempts",
            cache_path,
            count,
        )
        return True

    def keep_only(self, cache_paths: Iterable[str]) -> None:
        """Forget segments that left the cache (moved, dropped or trimmed)."""
        present = set(cache_paths)
        for cache_path in [path for path in self._counts if path not in present]:
            del self._counts[cache_path]
