"""Fork (SV6): say something once when a camera has been unreachable a while.

`CameraWatchdog` already restarts ffmpeg when a camera stops delivering frames
or valid recording segments, and the restarts show up in the Camera Health
card, but nothing ever says "this camera has been down for hours". A doorbell
that dropped off the network for 20 hours only left thousands of identical
restart lines in the log, and nobody was told.

`CameraOutageTracker` watches the times of the last frame and the last valid
recording segment and crosses a threshold (10 minutes by default) into an
outage. It emits exactly one event when the outage starts and one when the
camera comes back, never a repeat while it stays down. The events go to the
log, to the shared outage history the stats process publishes for the Camera
Health card, and, when the fork's push flag is on, to the `camera_monitoring`
topic that already carries web push notifications.
"""

import logging
import os
import time
from collections.abc import Callable, MutableSequence
from typing import Any, NamedTuple

# Keep the same shape as the restart history (frigate/video/restart_log.py).
HISTORY_SECONDS = 24 * 3600
HISTORY_MAX = 50

DEFAULT_THRESHOLD_SECONDS = 600.0
MIN_THRESHOLD_SECONDS = 60.0

# Fork flags. The log line and the Camera Health entry are always on; the push
# notification is opt-in, since it reuses the user's alert notifications.
THRESHOLD_ENV = "FORK_CAMERA_OUTAGE_SECONDS"
PUSH_ENV = "FORK_CAMERA_OUTAGE_PUSH"

NO_FRAMES = "no frames"
NO_SEGMENTS = "no valid recording segments"


def outage_threshold(environ: dict[str, str] | None = None) -> float:
    """Seconds a camera may deliver nothing before it counts as unreachable."""
    raw = (environ if environ is not None else os.environ).get(THRESHOLD_ENV)

    if not raw:
        return DEFAULT_THRESHOLD_SECONDS

    try:
        seconds = float(raw)
    except ValueError:
        return DEFAULT_THRESHOLD_SECONDS

    # A threshold under a minute would fire on a normal reconnect.
    return max(MIN_THRESHOLD_SECONDS, seconds)


def push_enabled(environ: dict[str, str] | None = None) -> bool:
    """Whether outages are also sent as a push notification (off by default)."""
    raw = (environ if environ is not None else os.environ).get(PUSH_ENV, "")
    return raw.strip().lower() in ("1", "true", "yes", "on")


def describe_duration(seconds: float) -> str:
    """A short, human readable outage length for logs and notifications."""
    seconds = max(seconds, 0.0)

    if seconds < 60:
        return f"{int(seconds)} seconds"

    minutes = int(seconds // 60)

    if minutes < 60:
        return "1 minute" if minutes == 1 else f"{minutes} minutes"

    hours, minutes = divmod(minutes, 60)

    if minutes == 0:
        return "1 hour" if hours == 1 else f"{hours} hours"

    return f"{hours}h {minutes}m"


class OutageState(NamedTuple):
    """The shared outage history and "down since" value a watchdog writes to."""

    events: MutableSequence[dict[str, Any]] | None = None
    since: Any | None = None


class CameraOutageTracker:
    """One camera's unreachable state, with one event per state change."""

    def __init__(
        self,
        camera: str,
        logger: logging.Logger,
        threshold: float | None = None,
        history: MutableSequence[dict[str, Any]] | None = None,
        since: Any | None = None,
        notify: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.camera = camera
        self.logger = logger
        self.threshold = outage_threshold() if threshold is None else threshold
        self.history = history if history is not None else []
        self.since = since
        self.notify = notify
        self.down_since: float | None = None
        self.reason: str = ""
        self._published_since: float = 0.0
        # When nothing has arrived yet, count from these instead of from 0.
        self._frame_baseline: float = 0.0
        self._segment_baseline: float = 0.0
        # The newest frame and segment ever seen. The watchdog's own counters
        # go back to 0 whenever ffmpeg restarts, which must not read as an
        # outage that started when the camera process did.
        self._last_frame_seen: float = 0.0
        self._last_segment_seen: float = 0.0
        self._was_recording = False

    def _publish_since(self) -> None:
        """Mirror the outage start into the camera stats, only when it moves.

        The watchdog calls this every second and the value is a manager proxy,
        so writing it unconditionally would be one IPC round trip per second
        per camera.
        """
        value = self.down_since or 0.0

        if value == self._published_since:
            return

        self._published_since = value

        if self.since is not None:
            self.since.value = value

    def _record(self, event: dict[str, Any]) -> dict[str, Any]:
        """Keep the last day of outage events for the Camera Health card."""
        self.history.append(event)
        now = event["time"]

        while len(self.history) > HISTORY_MAX or (
            self.history and self.history[0]["time"] < now - HISTORY_SECONDS
        ):
            del self.history[0]

        return event

    def reset(self, now: float | None = None) -> None:
        """Forget the outage state, for a camera that was just (re)started."""
        now = time.time() if now is None else now
        self.down_since = None
        self.reason = ""
        self._frame_baseline = now
        self._segment_baseline = now
        self._last_frame_seen = 0.0
        self._last_segment_seen = 0.0
        self._publish_since()

    def _reasons(self, now: float, record_enabled: bool) -> list[str]:
        reasons = []
        frame_time = self._last_frame_seen or self._frame_baseline or now

        if now - frame_time > self.threshold:
            reasons.append(NO_FRAMES)

        if record_enabled:
            segment_time = self._last_segment_seen or self._segment_baseline or now

            if now - segment_time > self.threshold:
                reasons.append(NO_SEGMENTS)

        return reasons

    def update(
        self,
        now: float,
        enabled: bool = True,
        last_frame_time: float = 0.0,
        record_enabled: bool = False,
        last_segment_time: float = 0.0,
    ) -> dict[str, Any] | None:
        """Fold one watchdog tick in; returns an event only on a state change.

        A disabled camera is not expected to deliver anything, so it never
        starts an outage and a running one is dropped without a recovery.
        """
        if not enabled:
            self.reset(now)
            return None

        if not self._frame_baseline:
            self.reset(now)

        if record_enabled and not self._was_recording:
            # Recording was just turned on; segments start arriving from here.
            self._segment_baseline = now
            self._last_segment_seen = 0.0
        self._was_recording = record_enabled

        self._last_frame_seen = max(self._last_frame_seen, last_frame_time)
        self._last_segment_seen = max(self._last_segment_seen, last_segment_time)

        reasons = self._reasons(now, record_enabled)

        if reasons and self.down_since is None:
            return self._start_outage(now, reasons)

        if not reasons and self.down_since is not None:
            return self._end_outage(now)

        return None

    def _start_outage(self, now: float, reasons: list[str]) -> dict[str, Any]:
        self.down_since = now - self.threshold
        self.reason = " and ".join(reasons)
        self._publish_since()
        event = self._record(
            {
                "time": round(now, 1),
                "camera": self.camera,
                "state": "down",
                "reason": self.reason,
                "since": round(self.down_since, 1),
            }
        )
        self.logger.warning(
            "%s looks unreachable: %s for over %s",
            self.camera,
            self.reason,
            describe_duration(self.threshold),
        )
        self._send(event)
        return event

    def _end_outage(self, now: float) -> dict[str, Any]:
        down_since = self.down_since or now
        duration = max(now - down_since, 0.0)
        self.down_since = None
        self.reason = ""
        self._publish_since()
        event = self._record(
            {
                "time": round(now, 1),
                "camera": self.camera,
                "state": "recovered",
                "reason": "",
                "since": round(down_since, 1),
                "duration": round(duration, 1),
            }
        )
        self.logger.info(
            "%s is delivering again after %s unreachable",
            self.camera,
            describe_duration(duration),
        )
        self._send(event)
        return event

    def _send(self, event: dict[str, Any]) -> None:
        if self.notify is None:
            return

        try:
            self.notify(event)
        except Exception:
            # A notification must never take the watchdog thread down.
            self.logger.exception("Failed to send the outage notification")


def outage_message(event: dict[str, Any]) -> str:
    """The one line a push notification carries for an outage event."""
    if event["state"] == "down":
        return (
            f"{event['camera']} has been unreachable for over "
            f"{describe_duration(event['time'] - event['since'])} "
            f"({event['reason']})"
        )

    return (
        f"{event['camera']} is delivering again after "
        f"{describe_duration(event.get('duration', 0.0))} unreachable"
    )
