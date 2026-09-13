"""Bounded persistent AI samples, collected independently of browser visits."""

import json
import sqlite3
import time
from pathlib import Path

from frigate.const import CONFIG_DIR

HISTORY_PATH = Path(CONFIG_DIR) / "ai-model-history.sqlite"
RETENTION = 86400


def save_sample(sample: dict, path: Path = HISTORY_PATH) -> None:
    """Store at most one sample per minute and prune beyond one day."""
    with sqlite3.connect(path, timeout=2) as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS samples (minute INTEGER PRIMARY KEY, data TEXT)"
        )
        now = sample["updated"]
        db.execute(
            "INSERT OR REPLACE INTO samples VALUES (?, ?)",
            (int(now // 60), json.dumps(sample, allow_nan=False)),
        )
        db.execute(
            "DELETE FROM samples WHERE minute <= ?", (int((now - RETENTION) // 60),)
        )


def read_history(path: Path = HISTORY_PATH) -> list[dict]:
    """Read retained samples without creating a missing database."""
    if not path.exists():
        return []
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=2) as db:
        rows = db.execute(
            "SELECT data FROM samples WHERE minute > ? ORDER BY minute",
            (int((time.time() - RETENTION) // 60),),
        )
        return [json.loads(row[0]) for row in rows]
