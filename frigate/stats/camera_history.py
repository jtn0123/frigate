"""Bounded per-camera health history behind the System page's Health tab.

The stats emitter produces a snapshot every ``FREQUENCY_STATS_POINTS``
seconds and keeps the last 80 in memory, which is barely 20 minutes. The
Health tab needs to answer "how did this camera behave over the last day or
week", so this module rolls those snapshots into fixed five-minute buckets
and keeps seven days of them on disk.

Only small numbers are kept: how many samples landed in a bucket, their frame
rate, and how many of them looked degraded or offline. Nothing here records
what a camera saw, so the file carries no footage-derived data.
"""

import json
import logging
import math
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from frigate.const import CONFIG_DIR

logger = logging.getLogger(__name__)

PATH = Path(CONFIG_DIR) / ".camera_history.json"

# One bucket per five minutes, seven days deep: 2016 buckets per camera.
BUCKET_SECONDS = 300
WINDOW_SECONDS = 7 * 24 * 3600
MAX_BUCKETS = WINDOW_SECONDS // BUCKET_SECONDS

# Ranges the Health tab offers, as (window, cell count). Every cell spans a
# whole number of buckets so a cell never straddles one.
RANGE_SPEC: dict[str, tuple[int, int]] = {
    "1h": (3600, 12),
    "6h": (6 * 3600, 24),
    "24h": (24 * 3600, 24),
    "7d": (7 * 24 * 3600, 28),
}
DEFAULT_RANGE = "24h"

# A camera is offline below this frame rate, and degraded below this share of
# its configured rate. These match the thresholds the Health cards already use
# on the client (LOW_FPS_RATIO in web/src/lib/fork/camera-health.ts).
OFFLINE_FPS = 0.1
DEGRADED_RATIO = 0.5

# Guards against a file that grew unexpectedly, or a config with a very large
# camera count, turning a read into an unbounded allocation.
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_CAMERAS = 200
MAX_INCIDENTS_PER_CAMERA = 50

# Written no more often than this, so a 15 second stats cadence does not mean
# a disk write every 15 seconds.
FLUSH_SECONDS = 300

CellState = Literal["ok", "degraded", "offline", "none"]

# Worst-wins when several buckets collapse into one cell.
_STATE_RANK: dict[CellState, int] = {
    "none": 0,
    "ok": 1,
    "degraded": 2,
    "offline": 3,
}


@dataclass
class Bucket:
    """Frame rate and health of one camera over one five-minute slot."""

    samples: int = 0
    fps_sum: float = 0.0
    fps_min: float | None = None
    expected_fps: float = 0.0
    degraded: int = 0
    offline: int = 0

    def add(self, fps: float, expected: float, state: CellState) -> None:
        self.samples += 1
        self.fps_sum += fps
        self.fps_min = fps if self.fps_min is None else min(self.fps_min, fps)
        self.expected_fps = expected
        if state == "offline":
            self.offline += 1
        elif state == "degraded":
            self.degraded += 1

    @property
    def mean_fps(self) -> float | None:
        if self.samples == 0:
            return None
        return self.fps_sum / self.samples

    @property
    def state(self) -> CellState:
        if self.samples == 0:
            return "none"
        if self.offline:
            return "offline"
        if self.degraded:
            return "degraded"
        return "ok"

    def encode(self) -> list[float]:
        return [
            self.samples,
            round(self.fps_sum, 2),
            -1.0 if self.fps_min is None else round(self.fps_min, 2),
            round(self.expected_fps, 2),
            self.degraded,
            self.offline,
        ]

    @classmethod
    def decode(cls, row: Any) -> "Bucket | None":
        if not isinstance(row, list) or len(row) != 6:
            return None
        try:
            samples, fps_sum, fps_min, expected, degraded, offline = (
                float(value) for value in row
            )
        except (TypeError, ValueError):
            return None
        return cls(
            samples=int(samples),
            fps_sum=fps_sum,
            fps_min=None if fps_min < 0 else fps_min,
            expected_fps=expected,
            degraded=int(degraded),
            offline=int(offline),
        )


@dataclass
class Incident:
    """One outage or ffmpeg restart, as the incident log shows it."""

    kind: str
    start: float
    end: float | None = None
    reason: str = ""

    def encode(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "start": self.start,
            "end": self.end,
            "reason": self.reason,
        }

    @classmethod
    def decode(cls, row: Any) -> "Incident | None":
        if not isinstance(row, dict):
            return None
        start = _number(row.get("start"))
        if start is None:
            return None
        kind = str(row.get("kind", ""))[:32]
        if not kind:
            return None
        return cls(
            kind=kind,
            start=start,
            end=_number(row.get("end")),
            reason=str(row.get("reason", ""))[:200],
        )


@dataclass
class CameraSeries:
    """Every retained bucket for one camera, keyed by absolute slot."""

    buckets: dict[int, Bucket] = field(default_factory=dict)
    incidents: list[Incident] = field(default_factory=list)


def _number(value: Any) -> float | None:
    """Return value as a finite float, or None when it is not one."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def classify(fps: float, expected: float, outage_since: float | None) -> CellState:
    """Classify one sample the way the Health cards classify a live camera.

    Args:
        fps: The camera's frame rate in this sample.
        expected: The configured detect frame rate.
        outage_since: When the camera went unreachable, or None.

    Returns:
        The state this sample contributes to its bucket.
    """
    if outage_since or fps < OFFLINE_FPS:
        return "offline"
    if expected > 0 and fps < expected * DEGRADED_RATIO:
        return "degraded"
    return "ok"


class CameraHistory:
    """Roll stats snapshots into per-camera buckets and serve them back."""

    def __init__(self, path: Path = PATH) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._cameras: dict[str, CameraSeries] = {}
        self._dirty = False
        self._last_flush = 0.0
        self._load()

    # ---- collection ----------------------------------------------------

    def record(self, stats: dict[str, Any], now: float | None = None) -> None:
        """Fold one stats snapshot into the current bucket of each camera.

        Args:
            stats: A snapshot from ``frigate.stats.util.stats_snapshot``.
            now: Collection time in epoch seconds, for tests.
        """
        moment = time.time() if now is None else now
        slot = int(moment // BUCKET_SECONDS)
        cameras = stats.get("cameras")
        if not isinstance(cameras, dict):
            return

        with self._lock:
            for name, camera in cameras.items():
                if not isinstance(camera, dict):
                    continue
                if name not in self._cameras and len(self._cameras) >= MAX_CAMERAS:
                    continue
                fps = _number(camera.get("camera_fps")) or 0.0
                expected = _number(camera.get("expected_fps")) or 0.0
                outage_since = _number(camera.get("outage_since"))
                series = self._cameras.setdefault(name, CameraSeries())
                bucket = series.buckets.get(slot)
                if bucket is None:
                    bucket = Bucket()
                    series.buckets[slot] = bucket
                bucket.add(fps, expected, classify(fps, expected, outage_since))
                self._merge_incidents(series, camera, moment)
            self._prune(moment)
            self._dirty = True

        self._maybe_flush(moment)

    def _merge_incidents(
        self, series: CameraSeries, camera: dict[str, Any], now: float
    ) -> None:
        """Add outages and restarts this snapshot reports but we have not kept.

        Frigate reports the last ten of each, so a snapshot every few seconds
        sees every incident at least once. Entries are matched on kind and
        start so the same incident is not stored twice, and an open outage is
        closed in place once the camera recovers.
        """
        # A restart is stored as "restart:<why>", so match on the kind before
        # the colon or the same restart is appended on every snapshot.
        seen = {
            (incident.kind.split(":", 1)[0], incident.start): incident
            for incident in series.incidents
        }

        outage_since = _number(camera.get("outage_since"))
        if outage_since:
            open_outage = seen.get(("outage", outage_since))
            if open_outage is None:
                series.incidents.append(
                    Incident(kind="outage", start=outage_since, reason="unreachable")
                )
            else:
                open_outage.end = None

        self._merge_outages(series, camera, seen)

        for event in _rows(camera.get("recent_restarts")):
            started = _number(event.get("time"))
            if started is None or ("restart", started) in seen:
                continue
            restart = Incident(
                kind=f"restart:{str(event.get('kind', 'other'))[:16]}",
                start=started,
                end=started,
                reason=str(event.get("message", ""))[:200],
            )
            series.incidents.append(restart)
            seen[("restart", started)] = restart

        cutoff = now - WINDOW_SECONDS
        series.incidents = sorted(
            (i for i in series.incidents if i.start >= cutoff),
            key=lambda i: i.start,
        )[-MAX_INCIDENTS_PER_CAMERA:]

    @staticmethod
    def _merge_outages(
        series: CameraSeries,
        camera: dict[str, Any],
        seen: dict[tuple[str, float], Incident],
    ) -> None:
        """Merge reported outages and close recovered intervals."""
        for event in _rows(camera.get("recent_outages")):
            since = _number(event.get("since"))
            if since is None:
                continue
            state = str(event.get("state", ""))
            incident = seen.get(("outage", since))
            if incident is None:
                incident = Incident(
                    kind="outage",
                    start=since,
                    reason=str(event.get("reason", ""))[:200],
                )
                series.incidents.append(incident)
                seen[("outage", since)] = incident
            if state == "recovered" and incident.end is None:
                duration = _number(event.get("duration"))
                event_time = _number(event.get("time"))
                if duration is not None:
                    incident.end = since + duration
                elif event_time is not None:
                    incident.end = event_time

    def _prune(self, now: float) -> None:
        """Drop buckets that fell out of the seven-day window."""
        oldest = int((now - WINDOW_SECONDS) // BUCKET_SECONDS)
        for series in self._cameras.values():
            if (
                len(series.buckets) <= MAX_BUCKETS
                and min(series.buckets, default=oldest) >= oldest
            ):
                continue
            series.buckets = {
                slot: bucket
                for slot, bucket in series.buckets.items()
                if slot >= oldest
            }

    # ---- reading -------------------------------------------------------

    def read(self, range_key: str, now: float | None = None) -> dict[str, Any]:
        """Aggregate the stored buckets into the cells one range needs.

        Args:
            range_key: One of the keys in ``RANGE_SPEC``.
            now: The window's end in epoch seconds, for tests.

        Returns:
            Per-camera frame rate, uptime and incidents over the window.
        """
        if range_key not in RANGE_SPEC:
            range_key = DEFAULT_RANGE
        window, cells = RANGE_SPEC[range_key]
        cell_seconds = window // cells
        per_cell = cell_seconds // BUCKET_SECONDS
        end = time.time() if now is None else now
        # Align the window to bucket boundaries so a cell always covers the
        # same slots the collector wrote.
        end_slot = int(end // BUCKET_SECONDS) + 1
        start_slot = end_slot - cells * per_cell

        with self._lock:
            cameras = {
                name: self._read_camera(series, start_slot, per_cell, cells)
                for name, series in sorted(self._cameras.items())
            }

        return {
            "range": range_key,
            "start": start_slot * BUCKET_SECONDS,
            "end": end_slot * BUCKET_SECONDS,
            "cell_seconds": cell_seconds,
            "bucket_seconds": BUCKET_SECONDS,
            "cameras": cameras,
        }

    def _read_camera(
        self, series: CameraSeries, start_slot: int, per_cell: int, cells: int
    ) -> dict[str, Any]:
        window_start = start_slot * BUCKET_SECONDS
        states: list[CellState] = []
        fps: list[float | None] = []
        samples = 0
        offline = 0
        expected = 0.0

        for cell in range(cells):
            base = start_slot + cell * per_cell
            cell_state: CellState = "none"
            cell_samples = 0
            cell_sum = 0.0
            for offset in range(per_cell):
                bucket = series.buckets.get(base + offset)
                if bucket is None:
                    continue
                cell_samples += bucket.samples
                cell_sum += bucket.fps_sum
                if _STATE_RANK[bucket.state] > _STATE_RANK[cell_state]:
                    cell_state = bucket.state
                if bucket.expected_fps:
                    expected = bucket.expected_fps
                samples += bucket.samples
                offline += bucket.offline
            states.append(cell_state)
            fps.append(round(cell_sum / cell_samples, 2) if cell_samples else None)

        uptime = (
            100.0 if samples == 0 else round(100.0 * (samples - offline) / samples, 2)
        )
        return {
            "uptime": uptime,
            # Every sample stands for one stats interval, so offline samples
            # scale to the time the camera was actually down.
            "downtime": (
                0
                if samples == 0
                else round(offline * (BUCKET_SECONDS * cells * per_cell) / samples)
            ),
            "samples": samples,
            "expected_fps": expected,
            "fps": fps,
            "states": states,
            "incidents": [
                incident.encode()
                for incident in series.incidents
                if self._incident_overlaps(incident, window_start)
            ],
        }

    @staticmethod
    def _incident_overlaps(incident: Incident, window_start: float) -> bool:
        """Include incidents starting in, ending in, or spanning the window."""
        return (
            incident.start >= window_start
            or incident.end is None
            or incident.end >= window_start
        )

    # ---- persistence ---------------------------------------------------

    def _load(self) -> None:
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("Oversized camera history snapshot")
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            return
        except (OSError, ValueError) as err:
            logger.warning("Ignoring unreadable camera history: %s", err)
            return

        cameras = data.get("cameras") if isinstance(data, dict) else None
        if not isinstance(cameras, dict):
            return

        cutoff = int((time.time() - WINDOW_SECONDS) // BUCKET_SECONDS)
        for name, raw in list(cameras.items())[:MAX_CAMERAS]:
            if not isinstance(raw, dict):
                continue
            self._cameras[str(name)] = self._decode_series(raw, cutoff)

    @staticmethod
    def _decode_series(raw: dict[str, Any], cutoff: int) -> CameraSeries:
        """Decode retained buckets and bounded incidents for one camera."""
        series = CameraSeries()
        for slot, row in (raw.get("buckets") or {}).items():
            try:
                index = int(slot)
            except (TypeError, ValueError):
                continue
            if index < cutoff:
                continue
            bucket = Bucket.decode(row)
            if bucket is not None:
                series.buckets[index] = bucket
        for row in _rows(raw.get("incidents")):
            incident = Incident.decode(row)
            if incident is not None:
                series.incidents.append(incident)
        series.incidents = series.incidents[-MAX_INCIDENTS_PER_CAMERA:]
        return series

    def _maybe_flush(self, now: float) -> None:
        if now - self._last_flush < FLUSH_SECONDS:
            return
        self.flush()

    def flush(self) -> None:
        """Write the current buckets out, replacing the file atomically."""
        with self._lock:
            if not self._dirty:
                return
            payload = {
                "version": 1,
                "updated": time.time(),
                "cameras": {
                    name: {
                        "buckets": {
                            str(slot): bucket.encode()
                            for slot, bucket in series.buckets.items()
                        },
                        "incidents": [i.encode() for i in series.incidents],
                    }
                    for name, series in self._cameras.items()
                },
            }
            self._dirty = False
            self._last_flush = time.time()

        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                dir=self.path.parent,
                prefix=self.path.name,
                suffix=".tmp",
                delete=False,
            ) as handle:
                json.dump(payload, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
                staged = Path(handle.name)
            staged.replace(self.path)
        except OSError as err:
            logger.warning("Could not write camera history: %s", err)


def _rows(value: Any) -> list[dict[str, Any]]:
    """Return value as a list of dicts, dropping anything else."""
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]
