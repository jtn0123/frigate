"""Publish bounded per-review results through the existing private shared mount."""

import hashlib
import json
import os
import time
from pathlib import Path


def publish(db, job: dict) -> None:
    """Atomically replace one review's result file, with seven-day retention."""
    root = Path(os.environ.get("TELEMETRY_DIR", "/telemetry")) / "results"
    root.mkdir(parents=True, exist_ok=True)
    review_id = job["id"].rsplit(":", 1)[0]
    rows = db.execute(
        "SELECT * FROM jobs WHERE substr(id,1,length(?)+1)=? || ':' "
        "AND camera=? ORDER BY start LIMIT 100",
        (review_id, review_id, job["camera"]),
    )
    chunks = []
    for row in rows:
        chunks.append(
            {
                "id": row["id"],
                "start": row["start"],
                "end": row["end"],
                "state": row["state"],
                "result": json.loads(row["result"]) if row["result"] else None,
            }
        )
    data = json.dumps(
        {
            "review_id": review_id,
            "camera": job["camera"],
            "updated": time.time(),
            "chunks": chunks,
        },
        ensure_ascii=False,
    )
    if len(data.encode()) > 1024 * 1024:
        raise ValueError("Review results exceed size limit")
    target = root / (hashlib.sha256(review_id.encode()).hexdigest() + ".json")
    temporary = target.with_suffix(".tmp")
    temporary.write_text(data)
    temporary.replace(target)
    # Cleanup is bounded by the worker's queue throughput and retained file cap.
    files = sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for index, path in enumerate(files):
        if index >= 10000 or path.stat().st_mtime < time.time() - 7 * 86400:
            path.unlink(missing_ok=True)
