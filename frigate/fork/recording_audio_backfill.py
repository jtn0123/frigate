"""Probe and store audio durations missing from recordings saved before B43."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from peewee import DatabaseError

from frigate.fork.recording_integrity import probe_recording_integrity
from frigate.models import Recordings
from frigate.util.config import resolve_ffmpeg_path

logger = logging.getLogger(__name__)

# one coverage request plans every clip three times (auto, main and sub
# timelines), so a probed row is remembered instead of probed again; the
# bound keeps a long uptime from growing it without limit
_CACHE_LIMIT = 512
_cache: dict[str, float | None] = {}
_cache_lock = threading.Lock()


def _probe_audio_seconds(path: str, duration: float) -> float | None:
    """Run the integrity probe for one saved segment from synchronous code."""
    integrity = asyncio.run(
        probe_recording_integrity(
            resolve_ffmpeg_path("default", "ffprobe"), path, duration, True
        )
    )
    if integrity.audio_seconds is None:
        logger.debug(
            "VOD: audio duration probe of %s failed (%s)", path, integrity.reason
        )
    return integrity.audio_seconds


def backfill_audio_duration(row: Any) -> float | None:
    """Probe a row's audio duration and store it, or None when it stays unknown.

    Rows recorded before the duration was stored have it NULL, so the vod
    manifest cannot tell that a clip starts after the audio ends. A failed
    probe returns None and keeps the earlier behavior of serving the clip.
    """
    with _cache_lock:
        if row.path in _cache:
            return _cache[row.path]

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        # the vod routes plan clips in worker threads; on an event loop the
        # probe would stall every other request, so leave the row unknown
        logger.debug("VOD: not probing audio of %s on an event loop", row.path)
        return None

    seconds = _probe_audio_seconds(row.path, row.duration)

    if seconds is not None:
        try:
            Recordings.update({Recordings.audio_duration: seconds}).where(
                Recordings.id == row.id
            ).execute()
        except DatabaseError:
            logger.debug("VOD: could not store audio duration of %s", row.path)

    with _cache_lock:
        if len(_cache) >= _CACHE_LIMIT:
            _cache.clear()
        _cache[row.path] = seconds

    return seconds
