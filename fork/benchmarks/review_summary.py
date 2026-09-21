"""Measure G11 with synthetic history in an isolated, fully migrated SQLite DB.

Run from the repository root in the backend test image:
  PYTHONPATH=. python3 fork/benchmarks/review_summary.py
No production database or credentials are used. Output is JSON.
"""

import argparse
import json
import math
import statistics
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.responses import JSONResponse
from peewee import SqliteDatabase
from peewee_migrate import Router

from frigate.api.defs.query.review_query_parameters import ReviewSummaryQueryParams
from frigate.api.review import review_summary
from frigate.models import ReviewSegment, User, UserReviewStatus

ROOT = Path(__file__).resolve().parents[2]


def history_row(index: int, timestamp: float) -> dict:
    """Build one synthetic review without camera credentials or real media."""
    return {
        "id": str(index),
        "camera": f"camera{index % 8}",
        "start_time": timestamp,
        "end_time": timestamp + 15,
        "severity": "alert" if index % 3 else "detection",
        "thumb_path": f"/synthetic/{index}.jpg",
        "data": {
            "objects": ["person" if index % 5 else "car"],
            "audio": ["bark"] if index % 7 else [],
            "zones": ["yard" if index % 2 else "driveway"],
        },
    }


def seed_history(db: SqliteDatabase, rows: int, days: int) -> None:
    """Populate bounded batches of synthetic camera history and user state."""
    now = time.time()
    with db.atomic():
        for offset in range(0, rows, 500):
            batch = []
            statuses = []
            for i in range(offset, min(rows, offset + 500)):
                timestamp = now - 60 - (i / rows) * days * 86400
                batch.append(history_row(i, timestamp))
                for user, modulus in (("alice", 3), ("bob", 5)):
                    if i % modulus == 0:
                        statuses.append(
                            {
                                "user_id": user,
                                "review_segment": str(i),
                                "has_been_reviewed": True,
                            }
                        )
            ReviewSegment.insert_many(batch).execute()
            UserReviewStatus.insert_many(statuses).execute()


def benchmark(rows: int, days: int, repeats: int) -> list[dict]:
    """Measure the actual handler, including serialization, with migrated indexes."""
    with tempfile.TemporaryDirectory(prefix="review-summary-") as directory:
        db = SqliteDatabase(
            Path(directory) / "benchmark.db", pragmas={"journal_mode": "wal"}
        )
        try:
            return run_cases(db, rows, days, repeats)
        finally:
            db.close()


def run_cases(db: SqliteDatabase, rows: int, days: int, repeats: int) -> list[dict]:
    """Migrate the isolated database and evaluate the representative cases."""
    with db.bind_ctx(
        [ReviewSegment, UserReviewStatus, User], bind_refs=False, bind_backrefs=False
    ):
        # Migration 030 binds User and UserReviewStatus, so scope migrations too.
        Router(db, migrate_dir=str(ROOT / "migrations")).run()
        seed_history(db, rows, days)
        cases: list[tuple[str, dict[str, str], int, str]] = [
            ("all_utc", {}, 8, "alice"),
            ("restricted", {}, 2, "bob"),
            ("person", {"labels": "person"}, 8, "alice"),
            (
                "audio_zone",
                {"labels": "bark", "zones": "yard,driveway"},
                8,
                "alice",
            ),
            ("no_match", {"labels": "absent"}, 8, "alice"),
            ("dst", {"timezone": "America/Los_Angeles"}, 8, "alice"),
            ("fractional_offset", {"timezone": "Asia/Kathmandu"}, 8, "alice"),
        ]
        results = []
        for name, filters, camera_count, user in cases:
            params = ReviewSummaryQueryParams(**filters)
            cameras = [f"camera{i}" for i in range(camera_count)]

            def request() -> JSONResponse:
                response = review_summary(params, {"username": user}, cameras)
                if not isinstance(response, JSONResponse):
                    raise TypeError("Expected a serialized review summary")
                return response

            for _ in range(2):
                request()
            elapsed = []
            for _ in range(repeats):
                start = time.perf_counter()
                response = request()
                elapsed.append((time.perf_counter() - start) * 1000)
            queries: list[tuple[str, Sequence[object] | None]] = []
            execute = db.execute_sql

            def capture(
                sql: str,
                params: Sequence[object] | None = None,
                commit: bool | None = None,
            ) -> Any:
                queries.append((sql, params))
                return execute(sql, params, commit)

            with patch.object(db, "execute_sql", side_effect=capture):
                request()
            plans = [
                list(execute("EXPLAIN QUERY PLAN " + sql, parameters))
                for sql, parameters in queries
            ]
            results.append(
                {
                    "rows": rows,
                    "days": days,
                    "case": name,
                    "median_ms": round(statistics.median(elapsed), 2),
                    "p95_ms": round(sorted(elapsed)[math.ceil(repeats * 0.95) - 1], 2),
                    "bytes": len(response.body),
                    "queries": len(queries),
                    "plans": plans,
                }
            )
    return results


def main() -> None:
    """Write reproducible workload metadata and measurements to stdout."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=10)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    print(
        json.dumps(
            {
                "warmups": 2,
                "repeats": args.repeats,
                "results": benchmark(5000, 30, args.repeats)
                + benchmark(50000, 365, args.repeats),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
