"""Bounded native notices for final recording integrity observations."""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Collection
from dataclasses import dataclass, field
from typing import Any

REPEAT_SECONDS = 300
RECOVERY_SECONDS = 60
MAX_EVENT_AGE = 120
MAX_CAMERAS = 200
MAX_EVENTS_PER_TICK = 256
FAILURE_REASONS = frozenset(
    {
        "duration_mismatch",
        "video_timing",
        "audio_timing",
        "audio_missing",
        "probe_failed",
        "probe_timeout",
        "probe_limit",
    }
)


@dataclass
class Episode:
    """Last observed failure and uninterrupted verified recovery for a camera."""

    observed_at: float
    emitted: dict[str, float] = field(default_factory=dict)
    healthy_since: float | None = None


class RecordingIntegrityStatus:
    """Coalesce failures without treating recovery as repair of old footage.

    Notices remain available to acknowledge after recovery. Only a new episode,
    new failure category, or five-minute repeat makes a notice reappear.
    Main-stream failures cannot be cleared by sub-stream successes, malformed
    events, delayed observations, or a single valid short segment.
    """

    def __init__(
        self,
        raise_notice: Callable[..., None],
        *,
        elapsed_clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._raise_notice = raise_notice
        self._elapsed_clock = elapsed_clock
        self._episodes: dict[str, Episode] = {}

    def update(self, payload: Any, now: float, cameras: Collection[str]) -> None:
        """Accept a fresh, finite internal observation for a configured camera."""
        allowed = set(list(cameras)[:MAX_CAMERAS])
        self._episodes = {
            name: episode for name, episode in self._episodes.items() if name in allowed
        }
        if not isinstance(payload, (tuple, list)) or len(payload) != 4:
            return
        camera, stream, observed_at, detail = payload
        if not isinstance(camera, str) or camera not in allowed or stream != "main":
            return
        if (
            isinstance(observed_at, bool)
            or not isinstance(observed_at, (int, float))
            or not math.isfinite(now)
            or not now - MAX_EVENT_AGE <= observed_at <= now
            or not isinstance(detail, dict)
        ):
            return
        reason = detail.get("reason")
        if not isinstance(reason, str) or reason not in FAILURE_REASONS | {"ok"}:
            return
        previous = self._episodes.get(camera)
        if previous is not None:
            if previous.observed_at > now:
                # A host clock correction must not hide subsequent observations.
                previous.healthy_since = None
            elif observed_at <= previous.observed_at:
                return
        elapsed = self._elapsed_clock()
        episode = previous or Episode(observed_at)
        self._episodes[camera] = episode
        gap = observed_at - episode.observed_at
        episode.observed_at = observed_at
        if reason == "ok":
            audio_status = detail.get("audio_status")
            video_seconds = detail.get("video_seconds")
            if (
                not isinstance(audio_status, str)
                or audio_status not in {"ok", "not_present"}
                or detail.get("quarantined") is not False
                or isinstance(video_seconds, bool)
                or not isinstance(video_seconds, (int, float))
                or not 0 < video_seconds <= 600
            ):
                episode.healthy_since = None
                return
            if gap > RECOVERY_SECONDS:
                episode.healthy_since = None
            if episode.healthy_since is None:
                episode.healthy_since = elapsed
            elif elapsed - episode.healthy_since >= RECOVERY_SECONDS:
                episode.emitted.clear()
            return
        episode.healthy_since = None
        kind = (
            "recording_audio_integrity"
            if reason in {"audio_timing", "audio_missing"}
            else "recording_video_integrity"
        )
        emitted_at = episode.emitted.get(kind)
        if emitted_at is None or elapsed - emitted_at >= REPEAT_SECONDS:
            self._raise_notice(kind, scope=camera, params={"reason": reason})
            episode.emitted[kind] = elapsed
