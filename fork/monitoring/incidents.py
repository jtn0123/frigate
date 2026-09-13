"""Persist bounded, transcript-free evidence and sustained health incidents."""

import json
import math
import sqlite3


def numeric(value):
    """Reject missing or nonfinite measurements instead of treating them as zero."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


class Incidents:
    """Track independent health dimensions and retain one day of evidence."""

    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS samples (time REAL, data TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS sample_time ON samples(time)")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS incidents (key TEXT PRIMARY KEY, started REAL, updated REAL, resolved REAL, evidence TEXT)"
        )
        self.last_source = None
        self.streaks = {}
        self.capture_missing = {}
        self.previous_containers = {}

    def observe(self, sample):
        """Only distinct fresh source samples advance detector/skip thresholds."""
        now = sample["time"]
        source = sample.get("source_updated")
        fresh = numeric(source) and 0 <= now - source <= 90
        problems = set()
        if not fresh:
            problems.add("monitoring:stale")
        if fresh and (
            not sample.get("cameras")
            or not sample.get("containers")
            or any(
                c.get("running") is None for c in sample.get("containers", {}).values()
            )
            or not sample.get("detector_ms")
            or any(
                camera.get("enabled") and not numeric(camera.get("camera_fps"))
                for camera in sample.get("cameras", {}).values()
            )
        ):
            problems.add("monitoring:partial")
        advance = fresh and source != self.last_source
        if advance:
            self.last_source = source
            slow = any(
                numeric(v) and v > 30 for v in sample.get("detector_ms", {}).values()
            )
            if any(numeric(v) for v in sample.get("detector_ms", {}).values()):
                self.streaks["ai:slow"] = (
                    self.streaks.get("ai:slow", 0) + 1 if slow else 0
                )
            for name, camera in sample.get("cameras", {}).items():
                key = "detection:" + name
                value = camera.get("skipped_fps")
                if not numeric(value):
                    continue
                self.streaks[key] = (
                    self.streaks.get(key, 0) + 1
                    if numeric(value) and value > 0.5
                    else 0
                )
        if fresh:
            problems.update(key for key, count in self.streaks.items() if count >= 3)
        for name, camera in sample.get("cameras", {}).items():
            if not camera.get("enabled"):
                continue
            fps = camera.get("camera_fps")
            if fresh and numeric(fps) and fps <= 0:
                since = self.capture_missing.setdefault(name, now)
                if now - since >= 20:
                    problems.add("capture:" + name)
            elif fresh and numeric(fps):
                self.capture_missing.pop(name, None)
            end = camera.get("recording_end")
            if camera.get("recording_expected") and numeric(end) and now - end > 120:
                problems.add("recording:" + name)
            elif camera.get("recording_expected") and not numeric(end):
                problems.add("recording_unknown:" + name)
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
        failure_time = sample.get("audio_failure", {}).get("updated")
        if sample.get("audio_failures", 0) or (
            numeric(failure_time) and 0 <= now - failure_time <= 30
        ):
            problems.add("audio:failure")
        evidence = json.dumps(sample, allow_nan=False)
        self.db.execute("INSERT INTO samples VALUES (?,?)", (now, evidence))
        for key in problems:
            self.db.execute(
                "INSERT INTO incidents VALUES (?,?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET started=CASE WHEN resolved IS NULL THEN started ELSE excluded.started END, updated=excluded.updated,resolved=NULL,evidence=excluded.evidence",
                (key, now, now, evidence),
            )
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
                "capture": fresh and numeric(camera.get("camera_fps")),
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
            if key not in problems and observable:
                self.db.execute(
                    "UPDATE incidents SET resolved=? WHERE key=?", (now, key)
                )
        self.db.execute("DELETE FROM samples WHERE time < ?", (now - 86400,))
        self.db.execute("DELETE FROM incidents WHERE resolved < ?", (now - 86400,))
        self.db.commit()
        return self.report(now)

    def report(self, now):
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
