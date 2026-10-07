"""Observe bounded main-recording coverage without reading media files."""

from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import tempfile
import threading
import time
from collections.abc import Callable, Iterable
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from frigate.const import CONFIG_DIR, MAX_SEGMENT_DURATION

if TYPE_CHECKING:
    from frigate.config import FrigateConfig

logger = logging.getLogger(__name__)

BUCKET_SECONDS = 300
INGESTION_GRACE_SECONDS = 120
WINDOW_SECONDS = 7 * 86400
MAX_BUCKETS = WINDOW_SECONDS // BUCKET_SECONDS
MAX_CAMERAS = 200
MAX_ROWS = 4096
MAX_WORK_PER_TICK = 32
MAX_FILE_BYTES = 64 * 1024 * 1024
POLL_SECONDS = 15
MAX_OBSERVATION_GAP = 3 * POLL_SECONDS
FLUSH_SECONDS = 300
GAP_SECONDS = 10
RECHECK_BUCKETS = 3
RECHECK_SECONDS = 60
EPSILON = 0.000001
RANGES = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": WINDOW_SECONDS}
PATH = Path(CONFIG_DIR) / ".recording_health.json"
RowReader = Callable[[str, float, float], Iterable[tuple[float, float]]]
_STATES = ("analyzed", "disabled", "not_continuous", "unknown")


class StopEvent(Protocol):
    """Shutdown event supplied by the owning Frigate process."""

    def wait(self, timeout: float) -> bool:
        """Wait for shutdown or the next collection interval."""
        ...


@dataclass(frozen=True)
class Policy:
    """Recording expectation observed while the collector is running."""

    state: str
    retention_seconds: float = 0


@dataclass
class Observation:
    """Policy and elapsed observation time within an unfinished bucket."""

    seconds: float = 0
    policy: Policy | None = None

    def add(self, seconds: float, policy: Policy) -> None:
        """Accumulate time without assuming that a changed policy was continuous."""
        if self.policy is None:
            self.policy = policy
        elif self.policy != policy:
            self.policy = Policy("unknown")
        self.seconds += seconds


@dataclass(frozen=True)
class Bucket:
    """Compact coverage with edge gaps retained for cross-bucket merging."""

    state: str
    missing: float = 0
    leading: float = 0
    trailing: float = 0
    longest_inner: float = 0
    inner_count: int = 0

    def encode(self) -> list[float | int]:
        """Return a compact, numeric persistence row."""
        return [
            _STATES.index(self.state),
            self.missing,
            self.leading,
            self.trailing,
            self.longest_inner,
            self.inner_count,
        ]

    @classmethod
    def decode(cls, row: Any) -> Bucket | None:
        """Reject malformed persisted rows instead of reporting false health."""
        if not cls._valid_numeric_row(row):
            return None
        state, missing, leading, trailing, longest, count = row
        bucket = cls(
            _STATES[int(state)], missing, leading, trailing, longest, int(count)
        )
        return bucket if bucket._valid_gap_totals() else None

    @staticmethod
    def _valid_numeric_row(row: Any) -> bool:
        if not isinstance(row, list) or len(row) != 6:
            return False
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in row):
            return False
        if not all(math.isfinite(v) for v in row):
            return False
        state, *_, count = row
        if int(state) != state or not 0 <= state < len(_STATES):
            return False
        if any(not 0 <= v <= BUCKET_SECONDS for v in row[1:5]):
            return False
        return bool(int(count) == count and 0 <= count <= MAX_ROWS)

    def _valid_gap_totals(self) -> bool:
        if self.state != "analyzed":
            return not any(
                (
                    self.missing,
                    self.leading,
                    self.trailing,
                    self.longest_inner,
                    self.inner_count,
                )
            )
        if (
            max(self.leading, self.trailing, self.longest_inner)
            > self.missing + EPSILON
        ):
            return False
        if self.leading + self.trailing > self.missing + EPSILON and not (
            self.missing == self.leading == self.trailing == BUCKET_SECONDS
        ):
            return False
        if self.missing == BUCKET_SECONDS:
            return (
                self.leading == self.trailing == self.missing
                and not self.longest_inner
                and not self.inner_count
            )
        inner_missing = self.missing - self.leading - self.trailing
        return (
            self.longest_inner <= inner_missing + EPSILON
            and self.inner_count * GAP_SECONDS <= inner_missing + EPSILON
            and bool(self.inner_count) == (self.longest_inner >= GAP_SECONDS)
        )


def coverage_bucket(rows: Iterable[tuple[float, float]], start: float) -> Bucket:
    """Union bounded, overlapping recording intervals within one full bucket.

    Raises ValueError when rows are invalid or truncated, so partial results
    cannot be mistaken for missing recordings. Empty successful scans are gaps.
    """
    end = start + BUCKET_SECONDS
    merged: list[list[float]] = []
    for left, right in sorted(_clipped_intervals(rows, start, end)):
        if merged and left <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], right)
        else:
            merged.append([left, right])
    if not merged:
        return Bucket("analyzed", BUCKET_SECONDS, BUCKET_SECONDS, BUCKET_SECONDS)
    inner = [b[0] - a[1] for a, b in zip(merged, merged[1:])]
    missing = max(0.0, BUCKET_SECONDS - sum(right - left for left, right in merged))
    return Bucket(
        "analyzed",
        missing,
        merged[0][0] - start,
        end - merged[-1][1],
        max(inner, default=0.0),
        sum(gap >= GAP_SECONDS for gap in inner),
    )


def _clipped_intervals(
    rows: Iterable[tuple[float, float]], start: float, end: float
) -> list[tuple[float, float]]:
    """Validate the entire bounded scan before calculating partial coverage."""
    intervals = []
    for count, row in enumerate(rows, 1):
        if count > MAX_ROWS:
            raise ValueError("Recording health row limit exceeded")
        left, right = (float(value) for value in row)
        if not math.isfinite(left) or not math.isfinite(right):
            raise ValueError("Non-finite recording interval")
        if right <= left or right - left > MAX_SEGMENT_DURATION:
            raise ValueError("Invalid recording interval")
        left, right = max(start, left), min(end, right)
        if right > left:
            intervals.append((left, right))
    return intervals


class RecordingHealth(threading.Thread):
    """Collect bounded coverage observations and expose cheap cached summaries.

    Only buckets whose recording policy was continuously observed are queried.
    A restart never backfills missing history from the current configuration.
    Recent deficits can improve after late ingestion while retention guarantees
    still apply. Restarted collectors never reconstruct those recheck guarantees.
    Coverage describes registered recordings as observed, not media integrity.
    """

    def __init__(
        self,
        config: FrigateConfig,
        stop_event: StopEvent,
        path: Path = PATH,
        *,
        row_reader: RowReader | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        super().__init__(name="recording_health", daemon=True)
        self.stop_event = stop_event
        self.path = Path(path)
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: dict[str, dict[int, Bucket]] = {}
        self._pending: dict[tuple[str, int], Observation] = {}
        self._policies: dict[str, Policy] = {}
        self._rechecks: dict[tuple[str, int], tuple[Policy, float]] = {}
        self._policy_epoch = 0
        self._database_path = ""
        self._last_observation: float | None = None
        self._revision = 0
        self._saved_revision = 0
        self._last_flush = 0.0
        self._row_reader = row_reader or self._read_rows
        self._load()
        self.update_config(config)

    def update_config(self, config: FrigateConfig) -> None:
        """Observe a runtime policy transition without querying the database."""
        policies = self._configured_policies(config)
        with self._lock:
            self._observe_locked(self._clock())
            database_path = str(config.database.path)
            database_changed = bool(self._database_path) and (
                self._database_path != database_path
            )
            if policies != self._policies or database_changed:
                self._policy_epoch += 1
            # A later policy reduction may delete a previously observed interval.
            # Do not infer an outage from the remaining rows after that change.
            for (camera_name, _), observation in self._pending.items():
                if database_changed or not self._preserves_retention(
                    policies.get(camera_name), observation.policy
                ):
                    observation.policy = Policy("unknown")
            self._rechecks = {
                key: retry
                for key, retry in self._rechecks.items()
                if not database_changed
                and self._preserves_retention(policies.get(key[0]), retry[0])
            }
            self._policies = policies
            self._database_path = database_path
            self._limit_cameras_locked()

    @staticmethod
    def _configured_policies(config: FrigateConfig) -> dict[str, Policy]:
        policies: dict[str, Policy] = {}
        for name, camera in list(config.cameras.items())[:MAX_CAMERAS]:
            if not camera.enabled or not camera.record.enabled:
                policy = Policy("disabled")
            elif camera.record.continuous.days <= 0:
                policy = Policy("not_continuous")
            else:
                retention = float(camera.record.continuous.days) * 86400
                policy = (
                    Policy("analyzed", retention)
                    if math.isfinite(retention)
                    else Policy("unknown")
                )
            policies[name] = policy
        return policies

    def _limit_cameras_locked(self) -> None:
        """Give current cameras priority over removed-camera history at the cap."""
        keep = set(self._policies)
        for name in self._buckets:
            if len(keep) >= MAX_CAMERAS:
                break
            keep.add(name)
        if set(self._buckets) - keep:
            self._revision += 1
        self._buckets = {
            name: rows for name, rows in self._buckets.items() if name in keep
        }
        self._pending = {
            key: row for key, row in self._pending.items() if key[0] in keep
        }

    @staticmethod
    def _preserves_retention(current: Policy | None, original: Policy | None) -> bool:
        return bool(
            current
            and original
            and (
                current == original
                or (
                    current.state == original.state == "analyzed"
                    and current.retention_seconds >= original.retention_seconds
                )
            )
        )

    def _observe_locked(self, now: float) -> None:
        previous = self._last_observation
        self._last_observation = now
        if previous is None:
            return
        if now < previous:
            self._pending.clear()
            return
        if now - previous > MAX_OBSERVATION_GAP:
            return
        while previous < now:
            slot = int(previous // BUCKET_SECONDS)
            until = min(now, (slot + 1) * BUCKET_SECONDS)
            for name, policy in self._policies.items():
                if slot not in self._buckets.get(name, {}):
                    self._pending.setdefault((name, slot), Observation()).add(
                        until - previous, policy
                    )
            previous = until

    def collect(self, now: float | None = None) -> None:
        """Observe policy and assess a bounded batch of mature buckets."""
        moment = self._clock() if now is None else now
        with self._lock:
            self._observe_locked(moment)
            self._prune_locked(moment)
            due = sorted(
                (
                    key
                    for key in self._pending
                    if (key[1] + 1) * BUCKET_SECONDS <= moment - INGESTION_GRACE_SECONDS
                ),
                key=lambda key: (key[1], key[0]),
            )[:MAX_WORK_PER_TICK]
            epoch = self._policy_epoch
            jobs = [(key, self._pending.pop(key)) for key in due]
            retries = sorted(
                (
                    (key, policy)
                    for key, (policy, next_check) in self._rechecks.items()
                    if next_check <= moment
                ),
                key=lambda item: (item[0][1], item[0][0]),
            )[: MAX_WORK_PER_TICK - len(jobs)]
        for (camera, slot), observation in jobs:
            self._collect_observation(camera, slot, observation, moment, epoch)
        for (camera, slot), policy in retries:
            self._recheck_bucket(camera, slot, policy, moment, epoch)
        if moment - self._last_flush >= FLUSH_SECONDS:
            self.flush()

    def _collect_observation(
        self,
        camera: str,
        slot: int,
        observation: Observation,
        moment: float,
        epoch: int,
    ) -> None:
        """Assess outside the lock, then validate policy before storing a bucket."""
        start = slot * BUCKET_SECONDS
        policy = observation.policy or Policy("unknown")
        bucket = Bucket("unknown")
        if abs(observation.seconds - BUCKET_SECONDS) <= EPSILON:
            if policy.state != "analyzed":
                bucket = Bucket(policy.state)
            elif policy.retention_seconds > max(moment, self._clock()) - start:
                bucket = self._assess(camera, start) or bucket
        with self._lock:
            assessed_at = max(moment, self._clock())
            if epoch != self._policy_epoch or (
                policy.state == "analyzed"
                and policy.retention_seconds <= assessed_at - start
            ):
                bucket = Bucket("unknown")
            if camera not in self._buckets and len(self._buckets) >= MAX_CAMERAS:
                return
            self._buckets.setdefault(camera, {})[slot] = bucket
            if (
                epoch == self._policy_epoch
                and abs(observation.seconds - BUCKET_SECONDS) <= EPSILON
                and policy.state == "analyzed"
                and policy.retention_seconds > assessed_at - start
                and (bucket.state == "unknown" or bucket.missing > EPSILON)
            ):
                self._rechecks[(camera, slot)] = (policy, moment + RECHECK_SECONDS)
            self._revision += 1

    def _recheck_bucket(
        self, camera: str, slot: int, policy: Policy, moment: float, epoch: int
    ) -> None:
        """Repair a recent deficit only while its original guarantee remains valid."""
        start = slot * BUCKET_SECONDS
        with self._lock:
            if (
                epoch != self._policy_epoch
                or (camera, slot) not in self._rechecks
                or policy.retention_seconds <= max(moment, self._clock()) - start
            ):
                self._rechecks.pop((camera, slot), None)
                return
            self._rechecks[(camera, slot)] = (policy, moment + RECHECK_SECONDS)
        checked = self._assess(camera, start)
        with self._lock:
            original = self._buckets.get(camera, {}).get(slot)
            if (
                epoch != self._policy_epoch
                or policy.retention_seconds <= max(moment, self._clock()) - start
                or checked is None
                or original is None
                or (original.state == "analyzed" and checked.missing > original.missing)
            ):
                return
            if original != checked:
                self._buckets[camera][slot] = checked
                self._revision += 1
            if checked.missing <= EPSILON:
                self._rechecks.pop((camera, slot), None)

    def _assess(self, camera: str, start: float) -> Bucket | None:
        try:
            return coverage_bucket(
                self._row_reader(camera, start, start + BUCKET_SECONDS), start
            )
        except (sqlite3.Error, OSError, ValueError, TypeError, RuntimeError) as err:
            # Exception text can contain database paths; report its type only.
            logger.warning(
                "Recording health unavailable for %s (%s)", camera, type(err).__name__
            )
            return None

    def _read_rows(
        self, camera: str, start: float, end: float
    ) -> Iterable[tuple[float, float]]:
        # Query compilation uses the model, but the dedicated connection is read-only
        # and has a small busy timeout instead of the main database's long timeout.
        from frigate.models import Recordings

        query = (
            Recordings.select(Recordings.start_time, Recordings.end_time)
            .where(
                (Recordings.camera == camera)
                & (Recordings.stream_type == "main")
                & (Recordings.start_time >= start - MAX_SEGMENT_DURATION)
                & (Recordings.start_time < end)
                & (Recordings.end_time > start)
            )
            .order_by(Recordings.start_time)
            .limit(MAX_ROWS + 1)
        )
        sql, params = query.sql()
        with self._lock:
            uri = Path(self._database_path).absolute().as_uri() + "?mode=ro"
        deadline = time.monotonic() + 1.0
        with closing(sqlite3.connect(uri, uri=True, timeout=0.1)) as db:
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            return db.execute(sql, params).fetchall()

    def read(
        self, range_key: str, now: float | None = None
    ) -> dict[str, dict[str, Any]]:
        """Return summaries of a full window ending at the mature bucket boundary.

        Percentages use only successfully analyzed seconds. Requested seconds
        include unavailable history; gaps never bridge those unknown periods.
        """
        moment = self._clock() if now is None else now
        end_slot = int((moment - INGESTION_GRACE_SECONDS) // BUCKET_SECONDS)
        requested = RANGES.get(range_key, RANGES["24h"])
        start_slot = end_slot - requested // BUCKET_SECONDS
        with self._lock:
            names = sorted(set(self._policies) | set(self._buckets))
            rows = {
                name: (
                    self._policies.get(name),
                    [
                        (slot, bucket)
                        for slot, bucket in sorted(self._buckets.get(name, {}).items())
                        if start_slot <= slot < end_slot
                    ],
                )
                for name in names
            }
        return {
            name: self._summary(policy, buckets, requested, end_slot)
            for name, (policy, buckets) in rows.items()
        }

    @staticmethod
    def _summary(
        policy: Policy | None,
        rows: list[tuple[int, Bucket]],
        requested: int,
        end_slot: int,
    ) -> dict[str, Any]:
        analyzed = 0
        missing = 0.0
        longest = 0.0
        count = 0
        pending_gap = 0.0
        previous_slot: int | None = None
        latest: float | None = None
        for slot, bucket in rows:
            if previous_slot != slot - 1 or bucket.state != "analyzed":
                count += pending_gap >= GAP_SECONDS
                longest = max(longest, pending_gap)
                pending_gap = 0.0
            previous_slot = slot
            if bucket.state != "analyzed":
                continue
            analyzed += BUCKET_SECONDS
            missing += bucket.missing
            latest = (slot + 1) * BUCKET_SECONDS
            if bucket.leading == bucket.trailing == BUCKET_SECONDS:
                pending_gap += BUCKET_SECONDS
                continue
            pending_gap += bucket.leading
            count += int(pending_gap >= GAP_SECONDS) + bucket.inner_count
            longest = max(longest, pending_gap, bucket.longest_inner)
            pending_gap = bucket.trailing
        count += pending_gap >= GAP_SECONDS
        longest = max(longest, pending_gap)
        status = "unknown"
        if analyzed:
            status = "gaps" if missing > analyzed * 0.01 or count else "ok"
        elif policy and policy.state in ("disabled", "not_continuous"):
            status = policy.state
        return {
            "status": status,
            "coverage_percent": round(100 * (analyzed - missing) / analyzed, 2)
            if analyzed
            else None,
            "analyzed_seconds": analyzed,
            "requested_seconds": requested,
            "missing_seconds": round(missing, 6),
            "gap_count": count,
            "longest_gap_seconds": round(longest, 6),
            "mature_before": end_slot * BUCKET_SECONDS,
            "latest_analyzed_end": latest,
        }

    def _prune_locked(self, now: float) -> None:
        oldest = int((now - WINDOW_SECONDS - INGESTION_GRACE_SECONDS) // BUCKET_SECONDS)
        for name in list(self._buckets):
            previous_count = len(self._buckets[name])
            self._buckets[name] = dict(
                sorted(
                    (slot, row)
                    for slot, row in self._buckets[name].items()
                    if slot >= oldest
                )[-MAX_BUCKETS:]
            )
            if len(self._buckets[name]) != previous_count:
                self._revision += 1
            if not self._buckets[name] and name not in self._policies:
                del self._buckets[name]
                self._revision += 1
        self._pending = {
            key: row for key, row in self._pending.items() if key[1] >= oldest
        }
        recheck_start = int((now - INGESTION_GRACE_SECONDS) // BUCKET_SECONDS)
        self._rechecks = {
            key: retry
            for key, retry in self._rechecks.items()
            if key[1] >= recheck_start - RECHECK_BUCKETS
            and key[1] * BUCKET_SECONDS + retry[0].retention_seconds > now
        }

    def _load(self) -> None:
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("Recording health snapshot exceeds limit")
            data = json.loads(self.path.read_text())
            if not isinstance(data, dict) or data.get("version") != 1:
                return
            cameras = data.get("cameras")
            if not isinstance(cameras, dict):
                return
            last = int((self._clock() - INGESTION_GRACE_SECONDS) // BUCKET_SECONDS)
            for name, rows in list(cameras.items())[:MAX_CAMERAS]:
                if not isinstance(rows, dict):
                    continue
                self._buckets[str(name)] = self._decode_history(rows, last)
        except FileNotFoundError:
            return
        except (OSError, ValueError, TypeError) as err:
            logger.warning("Could not load recording health (%s)", type(err).__name__)

    @staticmethod
    def _decode_history(rows: dict[str, Any], last: int) -> dict[int, Bucket]:
        """Keep valid observations within the retained mature window."""
        buckets = {}
        for key, value in rows.items():
            try:
                slot = int(key)
            except (TypeError, ValueError):
                continue
            bucket = Bucket.decode(value)
            if last - MAX_BUCKETS <= slot < last and bucket is not None:
                buckets[slot] = bucket
        return buckets

    def flush(self) -> None:
        """Atomically persist completed observations; retry failed writes later."""
        with self._lock:
            if self._revision == self._saved_revision:
                return
            revision = self._revision
            payload = {
                "version": 1,
                "cameras": {
                    name: {str(slot): bucket.encode() for slot, bucket in rows.items()}
                    for name, rows in self._buckets.items()
                },
            }
        staged: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                dir=self.path.parent,
                prefix=self.path.name,
                suffix=".tmp",
                delete=False,
            ) as handle:
                staged = Path(handle.name)
                json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            if staged.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("Recording health snapshot exceeds limit")
            staged.replace(self.path)
            with self._lock:
                self._saved_revision = revision
                self._last_flush = self._clock()
        except (OSError, ValueError) as err:
            logger.warning("Could not save recording health (%s)", type(err).__name__)
        finally:
            if staged is not None:
                try:
                    staged.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove staged recording health snapshot")

    def run(self) -> None:
        """Collect in the background until Frigate requests shutdown."""
        try:
            while not self.stop_event.wait(POLL_SECONDS):
                self.collect()
        finally:
            self.flush()
