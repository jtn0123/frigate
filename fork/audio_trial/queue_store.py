"""Durable, bounded queue for the isolated audio trial."""

import json
import logging
import math
import sqlite3
import time

from results import publish

logger = logging.getLogger(__name__)


class Queue:
    """Keep work and results across worker restarts."""

    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS jobs ("
            "id TEXT PRIMARY KEY, camera TEXT, start REAL, end REAL, "
            "created REAL, priority INTEGER, state TEXT, attempts INTEGER DEFAULT 0, "
            "result TEXT, reason TEXT, updated REAL)"
        )
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS jobs_camera_served "
            "ON jobs(camera,updated) WHERE attempts > 0"
        )
        had_publications = self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='publications'"
        ).fetchone()
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, camera TEXT, attempted REAL DEFAULT 0)"
        )
        if not had_publications:
            # Upgrade the existing trial without hiding its retained results.
            self.db.execute(
                "INSERT INTO publications (id,camera) SELECT id,camera FROM jobs WHERE result IS NOT NULL AND updated >= ?",
                (time.time() - 7 * 86400,),
            )
        self.db.execute(
            "UPDATE jobs SET state=CASE WHEN result IS NULL THEN 'pending' ELSE 'second_opinion' END WHERE state='running'"
        )
        self.db.commit()

    def enqueue(self, reviews: list[dict], now: float, cameras: list[str]) -> None:
        """Split settled review events into bounded chunks and deduplicate polls."""
        for review in reviews:
            camera = review["camera"]
            end = review.get("end_time")
            data = review.get("data", {})
            if camera not in cameras or not (
                data.get("audio") or "person" in data.get("objects", [])
            ):
                continue
            # Closed events only in this first trial; allow recordings to settle.
            if end is None or end > now - 20 or end < now - 600:
                continue
            start = review["start_time"] - 3
            end = end + 3
            index = max(0, int((now - 600 - start) // 28))
            start += index * 28
            while start < end:
                chunk_end = min(start + 30, end)
                self.db.execute(
                    "INSERT OR IGNORE INTO jobs "
                    "(id,camera,start,end,created,priority,state,updated) "
                    "VALUES (?,?,?,?,?,?,'pending',?)",
                    (
                        f"{review['id']}:{index}",
                        camera,
                        start,
                        chunk_end,
                        now,
                        cameras.index(camera),
                        now,
                    ),
                )
                start += 28  # Small overlap protects words at chunk boundaries.
                index += 1
        self.db.execute(
            "UPDATE jobs SET state='expired', reason='backlog age limit', updated=? "
            "WHERE state='pending' AND end < ?",
            (now, now - 600),
        )
        self.db.execute(
            "UPDATE jobs SET state='expired', reason='queue capacity', updated=? "
            "WHERE id IN (SELECT id FROM (SELECT id,priority,end, "
            "ROW_NUMBER() OVER (PARTITION BY camera ORDER BY created,start) AS camera_rank "
            "FROM jobs WHERE state='pending') "
            "ORDER BY CASE camera_rank WHEN 1 THEN 0 ELSE 1 END,priority,end DESC LIMIT -1 OFFSET 20)",
            (now,),
        )
        self.db.execute(
            "INSERT OR REPLACE INTO publications (id,camera) SELECT id,camera FROM jobs WHERE state='expired' AND updated=?",
            (now,),
        )
        self.db.execute("DELETE FROM jobs WHERE updated < ?", (now - 7 * 86400,))
        self.db.execute(
            "DELETE FROM publications WHERE id NOT IN (SELECT id FROM jobs)"
        )
        self.db.commit()

    def claim(self, now: float) -> dict | None:
        """Take one job; this queue has exactly one consumer."""
        expired = self.db.execute(
            "SELECT * FROM jobs WHERE state='second_opinion' AND created < ?",
            (now - 3600,),
        ).fetchall()
        for old in expired:
            result = json.loads(old["result"])
            result["large_status"] = "expired: second opinion age limit"
            self.finish(dict(old), now, result)
        row = self.db.execute(
            "SELECT * FROM jobs AS candidate WHERE state='pending' OR "
            "(state='second_opinion' AND updated < ?) "
            "ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, "
            "MAX(0,MIN(1,priority)-CAST((?-created)/60 AS INTEGER)), "
            "COALESCE((SELECT MAX(served.updated) FROM jobs AS served "
            "WHERE served.camera=candidate.camera AND served.attempts > 0),0), "
            "start LIMIT 1",
            (now - 60, now),
        ).fetchone()
        if row is None:
            return None
        self.db.execute(
            "UPDATE jobs SET state='running',attempts=attempts+1,updated=? WHERE id=?",
            (now, row["id"]),
        )
        self.db.commit()
        return dict(row)

    def finish(self, job: dict, now: float, result: dict) -> None:
        """Save model output separately from Frigate descriptions and alerts."""
        self.db.execute(
            "UPDATE jobs SET state='done',result=?,reason=NULL,updated=? WHERE id=?",
            (json.dumps(result, ensure_ascii=False), now, job["id"]),
        )
        self.db.execute(
            "INSERT OR REPLACE INTO publications (id,camera) VALUES (?,?)",
            (job["id"], job["camera"]),
        )
        self.db.commit()

        self.publish(job)

    def fail(self, job: dict, now: float, reason: str) -> None:
        """Retry a transient failure once, then keep an explicit failure record."""
        self.db.execute(
            "UPDATE jobs SET state=?,reason=?,updated=? WHERE id=?",
            ("pending" if job["attempts"] < 1 else "failed", reason, now, job["id"]),
        )
        self.db.execute(
            "INSERT OR REPLACE INTO publications (id,camera) VALUES (?,?)",
            (job["id"], job["camera"]),
        )
        self.db.commit()
        self.publish(job)

    def checkpoint(self, job: dict, now: float, result: dict) -> None:
        """Persist Medium while leaving in-flight work recoverable on restart."""
        self.db.execute(
            "UPDATE jobs SET result=?,updated=? WHERE id=?",
            (json.dumps(result, ensure_ascii=False), now, job["id"]),
        )
        self.db.execute(
            "INSERT OR REPLACE INTO publications (id,camera) VALUES (?,?)",
            (job["id"], job["camera"]),
        )
        self.db.commit()
        self.publish(job)

    def defer(self, job: dict, now: float, result: dict) -> None:
        """Atomically save a durable second opinion without repeating Medium."""
        self.db.execute(
            "UPDATE jobs SET state='second_opinion',result=?,updated=? WHERE id=?",
            (json.dumps(result, ensure_ascii=False), now, job["id"]),
        )
        self.db.execute(
            "INSERT OR REPLACE INTO publications (id,camera) VALUES (?,?)",
            (job["id"], job["camera"]),
        )
        self.db.commit()
        self.publish(job)

    def publish(self, job: dict) -> None:
        """Retain publication intent until the shared result mount recovers."""
        self.db.execute(
            "INSERT OR REPLACE INTO publications (id,camera) VALUES (?,?)",
            (job["id"], job["camera"]),
        )
        self.db.commit()
        self.flush_publications()

    def flush_publications(self) -> None:
        """Retry a bounded batch of result publications, including completed jobs."""
        for row in self.db.execute(
            "SELECT * FROM publications ORDER BY attempted LIMIT 10"
        ).fetchall():
            try:
                publish(self.db, dict(row))
            except (OSError, ValueError):
                logger.warning("Review audio publication unavailable")
                self.db.execute(
                    "UPDATE publications SET attempted=? WHERE id=?",
                    (time.time(), row["id"]),
                )
                self.db.commit()
                continue
            self.db.execute("DELETE FROM publications WHERE id=?", (row["id"],))
            self.db.commit()

    def recent(self) -> list[dict]:
        """Return recent job records for an operator report."""
        return [
            dict(r)
            for r in self.db.execute(
                "SELECT * FROM jobs ORDER BY created DESC LIMIT 100"
            )
        ]


def retry_reasons(result: dict) -> list[str]:
    """Use observable failure symptoms, never an invented accuracy percentage."""
    text = result.get("transcript", "").strip()
    reasons = []
    if result.get("speech_seconds", 0) >= 2 and not text:
        reasons.append("speech detected but no transcript")
    words = text.lower().split()
    if len(words) >= 12 and len(set(words)) / len(words) < 0.3:
        reasons.append("excessive repetition")
    return reasons


def health_reason(stats: dict, available_bytes: int, large: bool = False) -> str:
    """Defer optional analysis when camera processing or memory needs room."""
    if not isinstance(stats, dict):
        return "camera health unavailable"
    if any(
        not isinstance(stats.get(key), dict)
        or not stats[key]
        or any(not isinstance(row, dict) for row in stats[key].values())
        for key in ("detectors", "cameras")
    ):
        return "camera health unavailable"
    try:
        age = time.time() - float(stats["service"]["last_updated"])
        values = [
            available_bytes,
            age,
            *(c["skipped_fps"] for c in stats["cameras"].values()),
            *(d["inference_speed"] for d in stats["detectors"].values()),
        ]
        if (
            not all(
                math.isfinite(float(value)) and float(value) >= 0 for value in values
            )
            or age > 90
        ):
            return "camera health unavailable"
    except (KeyError, TypeError, ValueError):
        return "camera health unavailable"
    if any(float(c.get("skipped_fps", 0)) > 0.5 for c in stats["cameras"].values()):
        return "camera frames being skipped"
    if any(float(d["inference_speed"]) > 30 for d in stats["detectors"].values()):
        return "object detector busy"
    required = (7.5 if large else 5.0) * 1024**3
    if available_bytes < required:
        return "insufficient spare memory"
    return ""
