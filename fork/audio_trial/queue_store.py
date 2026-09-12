"""Durable, bounded queue for the isolated audio trial."""

import json
import sqlite3


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
        self.db.execute("UPDATE jobs SET state='pending' WHERE state='running'")
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
            "WHERE id IN (SELECT id FROM jobs WHERE state='pending' "
            "ORDER BY priority, end DESC LIMIT -1 OFFSET 20)",
            (now,),
        )
        self.db.execute("DELETE FROM jobs WHERE updated < ?", (now - 7 * 86400,))
        self.db.commit()

    def claim(self, now: float) -> dict | None:
        """Take one job; this queue has exactly one consumer."""
        row = self.db.execute(
            "SELECT * FROM jobs WHERE state='pending' ORDER BY priority,start LIMIT 1"
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
        self.db.commit()

    def fail(self, job: dict, now: float, reason: str) -> None:
        """Retry a transient failure once, then keep an explicit failure record."""
        self.db.execute(
            "UPDATE jobs SET state=?,reason=?,updated=? WHERE id=?",
            ("pending" if job["attempts"] < 1 else "failed", reason, now, job["id"]),
        )
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
    if not stats.get("detectors") or not stats.get("cameras"):
        return "camera health unavailable"
    if any(float(c.get("skipped_fps", 0)) > 0.5 for c in stats["cameras"].values()):
        return "camera frames being skipped"
    if any(float(d["inference_speed"]) > 30 for d in stats["detectors"].values()):
        return "object detector busy"
    required = (7.5 if large else 5.0) * 1024**3
    if available_bytes < required:
        return "insufficient spare memory"
    return ""
