"""Persist bounded, transcript-free evidence and sustained health incidents."""

import json
import math
import sqlite3
from pathlib import Path
from typing import Any, TypeGuard

# One health sample as collect_proxmox.py publishes it.
Sample = dict[str, Any]

# Streak keys: slow AI processing, and skipped detection frames per camera.
AI_SLOW = "ai:slow"
DETECTION = "detection:"


def numeric(value: object) -> TypeGuard[float]:
    """Reject missing or nonfinite measurements instead of treating them as zero."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


class Incidents:
    """Track independent health dimensions and retain one day of evidence."""

    def __init__(self, path: Path | str) -> None:
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS samples (time REAL, data TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS sample_time ON samples(time)")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS incidents (key TEXT PRIMARY KEY, started REAL, updated REAL, resolved REAL, evidence TEXT)"
        )
        self.last_source: float | None = None
        self.streaks: dict[str, int] = {}
        self.measured: set[str] = set()
        self.capture_missing: dict[str, float] = {}
        self.previous_containers: dict[str, dict[str, Any]] = {}

    def observe(self, sample: Sample) -> dict[str, Any]:
        """Only distinct fresh source samples advance detector/skip thresholds."""
        now = sample["time"]
        source = sample.get("source_updated")
        fresh = numeric(source) and 0 <= now - source <= 90
        problems: set[str] = set()
        if not fresh:
            problems.add("monitoring:stale")
        elif self.incomplete(sample):
            problems.add("monitoring:partial")
        if fresh and source != self.last_source:
            self.last_source = source
            self.advance_streaks(sample)
        if fresh:
            # An unmeasured streak keeps its incident open without refreshing it.
            problems.update(
                key for key in self.measured if self.streaks.get(key, 0) >= 3
            )
        self.camera_problems(sample, now, fresh, problems)
        self.container_problems(sample, problems)
        failure_time = sample.get("audio_failure", {}).get("updated")
        if sample.get("audio_failures", 0) or (
            numeric(failure_time) and 0 <= now - failure_time <= 30
        ):
            problems.add("audio:failure")
        return self.persist(sample, now, fresh, problems)

    @staticmethod
    def incomplete(sample: Sample) -> bool:
        """Require actual readings before displaying healthy dimensions."""
        return (
            not sample.get("cameras")
            or not sample.get("containers")
            or not sample.get("detector_ms")
            or any(
                c.get("running") is None for c in sample.get("containers", {}).values()
            )
            or any(
                camera.get("enabled") and not numeric(camera.get("camera_fps"))
                for camera in sample.get("cameras", {}).values()
            )
        )

    def advance_streaks(self, sample: Sample) -> None:
        """Advance sustained AI warnings only for numeric source readings."""
        self.measured = set()
        readings = [v for v in sample.get("detector_ms", {}).values() if numeric(v)]
        if readings:
            slow = any(v > 30 for v in readings)
            self.streaks[AI_SLOW] = self.streaks.get(AI_SLOW, 0) + 1 if slow else 0
            self.measured.add(AI_SLOW)
        cameras = sample.get("cameras")
        if isinstance(cameras, dict):
            # A disabled or removed camera must not resume its old streak.
            for key in [k for k in self.streaks if k.startswith(DETECTION)]:
                if key.removeprefix(DETECTION) not in cameras:
                    del self.streaks[key]
        for name, camera in (cameras or {}).items():
            key = DETECTION + name
            value = camera.get("skipped_fps")
            if not numeric(value):
                continue
            self.streaks[key] = self.streaks.get(key, 0) + 1 if value > 0.5 else 0
            self.measured.add(key)

    def camera_problems(
        self, sample: Sample, now: float, fresh: bool, problems: set[str]
    ) -> None:
        """Track capture and expected continuous recordings separately."""
        enabled = {
            name
            for name, camera in sample.get("cameras", {}).items()
            if camera.get("enabled")
        }
        # A stats gap or a camera leaving the sample restarts the capture grace.
        self.capture_missing = {
            name: since
            for name, since in self.capture_missing.items()
            if fresh and name in enabled
        }
        for name, camera in sample.get("cameras", {}).items():
            if camera.get("enabled"):
                self.capture_problem(name, camera, now, fresh, problems)
                self.recording_problem(name, camera, now, problems)

    def capture_problem(
        self,
        name: str,
        camera: dict[str, Any],
        now: float,
        fresh: bool,
        problems: set[str],
    ) -> None:
        """Require twenty seconds of fresh zero-FPS readings."""
        fps = camera.get("camera_fps")
        if not fresh or not numeric(fps):
            return
        if fps <= 0:
            since = self.capture_missing.setdefault(name, now)
            if now - since >= 20:
                problems.add("capture:" + name)
        else:
            self.capture_missing.pop(name, None)

    @staticmethod
    def recording_problem(
        name: str, camera: dict[str, Any], now: float, problems: set[str]
    ) -> None:
        """Only continuously recorded cameras must have a recent segment."""
        if not camera.get("recording_expected"):
            return
        end = camera.get("recording_end")
        if not numeric(end):
            problems.add("recording_unknown:" + name)
        elif now - end > 120:
            problems.add("recording:" + name)

    def container_problems(self, sample: Sample, problems: set[str]) -> None:
        """Track process availability, restarts and explicit OOM state."""
        for name, container in sample.get("containers", {}).items():
            if container.get("running") is False:
                problems.add("server:" + name)
            if container.get("running") is None:
                continue
            previous = self.previous_containers.get(name)
            if previous and (
                container.get("started") != previous.get("started")
                or container.get("restarts", 0) > previous.get("restarts", 0)
            ):
                problems.add("restart:" + name)
            self.previous_containers[name] = dict(container)
            if container.get("oom_killed"):
                problems.add("memory:" + name)

    def persist(
        self, sample: Sample, now: float, fresh: bool, problems: set[str]
    ) -> dict[str, Any]:
        """Retain incidents and bounded history atomically."""
        evidence = json.dumps(sample, allow_nan=False)
        self.db.execute("INSERT INTO samples VALUES (?,?)", (now, evidence))
        for key in problems:
            self.db.execute(
                "INSERT INTO incidents VALUES (?,?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET started=CASE WHEN resolved IS NULL THEN started ELSE excluded.started END, updated=excluded.updated,resolved=NULL,evidence=excluded.evidence",
                (key, now, now, evidence),
            )
        self.resolve(sample, now, fresh, problems)
        self.db.execute("DELETE FROM samples WHERE time < ?", (now - 86400,))
        self.db.execute("DELETE FROM incidents WHERE resolved < ?", (now - 86400,))
        self.db.commit()
        return self.report(now)

    def resolve(
        self, sample: Sample, now: float, fresh: bool, problems: set[str]
    ) -> None:
        """Clear incidents only when their own subsystem has a valid reading."""
        for (key,) in self.db.execute(
            "SELECT key FROM incidents WHERE resolved IS NULL"
        ).fetchall():
            # Recovery requires a valid reading for the affected subsystem.
            kind, _, scope = key.partition(":")
            camera = sample.get("cameras", {}).get(scope, {})
            observable = {
                "monitoring": fresh,
                "ai": fresh
                and any(numeric(v) for v in sample.get("detector_ms", {}).values()),
                # Zero FPS inside a restarted grace period is not a recovery.
                "capture": fresh
                and numeric(camera.get("camera_fps"))
                and camera["camera_fps"] > 0,
                "detection": fresh and numeric(camera.get("skipped_fps")),
                "recording": bool(camera) and numeric(camera.get("recording_end")),
                "recording_unknown": bool(camera)
                and numeric(camera.get("recording_end")),
                "server": sample.get("containers", {}).get(scope, {}).get("running")
                is not None,
                "memory": sample.get("containers", {}).get(scope, {}).get("running")
                is not None,
                "restart": sample.get("containers", {}).get(scope, {}).get("running")
                is not None,
                "audio": "audio_failures" in sample,
            }.get(kind, False)
            if key not in problems and (
                observable or self.scope_removed(sample, fresh, kind, scope)
            ):
                self.db.execute(
                    "UPDATE incidents SET resolved=? WHERE key=?", (now, key)
                )

    @staticmethod
    def scope_removed(
        sample: dict[str, Any], fresh: bool, kind: str, scope: str
    ) -> bool:
        """Treat a camera or container the fresh sample no longer lists as recovered.

        The snapshot lists only enabled cameras and existing containers, so a
        disabled or removed one never reports a valid reading again.
        """
        if not fresh:
            return False
        if kind in ("capture", "detection", "recording", "recording_unknown"):
            listed = sample.get("cameras")
        elif kind in ("server", "memory", "restart"):
            listed = sample.get("containers")
        else:
            return False
        return isinstance(listed, dict) and scope not in listed

    def report(self, now: float) -> dict[str, Any]:
        """Return bounded incident metadata and recent correlated measurements."""
        rows = self.db.execute(
            "SELECT key,started,updated,resolved FROM incidents ORDER BY updated DESC LIMIT 100"
        ).fetchall()
        samples = self.db.execute(
            "SELECT data FROM samples ORDER BY time DESC LIMIT 120"
        ).fetchall()
        return {
            "updated": now,
            "incidents": [
                dict(zip(("key", "started", "updated", "resolved"), row))
                for row in rows
            ],
            "samples": [json.loads(row[0]) for row in reversed(samples)],
        }
