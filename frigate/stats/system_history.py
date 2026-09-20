"""Fork (D54): system metrics kept beyond the in-memory stats window.

`StatsEmitter` holds `MAX_STATS_POINTS` samples 15 seconds apart, about 20
minutes, in memory and loses them on restart, so the System page could only
ever draw that window. One sample a minute of the fields the General tab
graphs is stored here instead and rolled up into coarser buckets as it ages,
so a month of history is a few thousand rows rather than the 43,200 a month
of minutes would be.
"""

import json
import math
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from frigate.const import CONFIG_DIR

HISTORY_PATH = Path(CONFIG_DIR) / "system-metrics-history.sqlite"

# Seconds between stored samples, and the coarsest bucket a read can ask for.
SAMPLE_INTERVAL = 60
MAX_POINTS = 120

# The fields the General tab's graphs read, in the dot notation
# `StatsEmitter.get_stats_history` accepts. Everything else stays out of the
# history; `cpu_usages` above all, which carries process command lines.
HISTORY_KEYS = (
    "detectors.inference_speed",
    "detectors.temperature",
    "detectors.cpu",
    "detectors.mem",
    "gpu_usages",
    "npu_usages",
    "processes.cpu",
    "processes.mem",
    "service.last_updated",
)


@dataclass(frozen=True)
class Tier:
    """One resolution of stored history."""

    # Seconds a row of this tier covers. Each is a multiple of the one before.
    seconds: int
    # How long a row stays at this resolution before it is rolled up. The
    # coarsest tier has no successor and leaves only by the retention prune.
    keep: int | None


TIERS = (
    Tier(SAMPLE_INTERVAL, 86400),
    Tier(900, 604800),
    Tier(14400, None),
)

# Bucket sizes a read may pick, coarsest last. Capped at the coarsest tier,
# because no read can be finer grained than the rows it has to average.
BUCKET_LADDER = (60, 120, 300, 600, 900, 1800, 3600, 7200, 14400)

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS samples (
    resolution INTEGER NOT NULL,
    bucket INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (resolution, bucket)
)
"""


def select_metrics(stats: dict[str, Any], keys: tuple[str, ...] = HISTORY_KEYS) -> dict:
    """Keep only the graphed fields, the way `/stats/history` selects them.

    Args:
        stats: One stats snapshot.
        keys: Top level or `parent.child` names to keep.

    Returns:
        The snapshot with everything else dropped.
    """
    top_level: list[str] = []
    nested: dict[str, list[str]] = {}

    for key in keys:
        if "." in key:
            parent, child = key.split(".", 1)
            nested.setdefault(parent, []).append(child)
        else:
            top_level.append(key)

    selected: dict[str, Any] = {}

    for key in top_level:
        value = stats.get(key)

        if value is not None:
            selected[key] = value

    for parent, children in nested.items():
        value = stats.get(parent)

        if not isinstance(value, dict):
            continue

        first = next(iter(value.values()), None)

        if isinstance(first, dict):
            # A dict of dicts (detectors, processes): filter every entry
            selected[parent] = {
                name: {
                    child: entry[child]
                    for child in children
                    if entry.get(child) is not None
                }
                for name, entry in value.items()
                if isinstance(entry, dict)
            }
        else:
            selected[parent] = {
                child: value[child]
                for child in children
                if value.get(child) is not None
            }

    return selected


@dataclass(frozen=True)
class Reading:
    """One numeric stats value and the way the snapshot wrote it."""

    value: float
    # "%" for a percentage string, empty otherwise
    suffix: str
    # True when the snapshot wrote this number as a string, which the
    # `FrigateStats` types and the graphs expect to stay a string
    text: bool


def measurement(value: Any) -> Reading | None:
    """Read a stats value as a number, keeping a unit suffix like `%`.

    Args:
        value: A number, or a string as `frigate/stats/util.py` formats one
            (`"12.5%"`, `"3.2"`, `"50"`).

    Returns:
        The reading, or None when the value is not a measurement (a vendor
        name, an empty reading from a GPU that reports none).
    """
    if isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        return Reading(float(value), "", False) if math.isfinite(value) else None

    if not isinstance(value, str):
        return None

    text = value.strip()
    suffix = ""

    if text.endswith("%"):
        text, suffix = text[:-1], "%"

    try:
        number = float(text)
    except ValueError:
        return None

    return Reading(number, suffix, True) if math.isfinite(number) else None


def merge_samples(samples: list[dict]) -> dict:
    """Average same-shaped stats samples into one bucket.

    Buckets of different widths are averaged with equal weight, which can
    only skew the one read bucket that straddles two stored tiers.

    Args:
        samples: Snapshots as `select_metrics` stores them.

    Returns:
        One snapshot whose numbers are the means of the inputs'.
    """
    merged = _merge([sample for sample in samples if isinstance(sample, dict)])
    return merged if isinstance(merged, dict) else {}


def _merge(values: list[Any]) -> Any:
    """Combine one field's values from every sample in a bucket."""
    children = [value for value in values if isinstance(value, dict)]

    if children:
        merged: dict[str, Any] = {}

        for key in dict.fromkeys(key for child in children for key in child):
            value = _merge([child[key] for child in children if key in child])

            if value is not None:
                merged[key] = value

        # An empty group (every reading dropped) is left out rather than
        # returned as `{}`
        return merged or None

    numbers = [reading for reading in map(measurement, values) if reading is not None]

    if numbers:
        mean = math.fsum(reading.value for reading in numbers) / len(numbers)
        # Written the way the last reading was, so a "12.5%" stays a
        # percentage string and a raw number stays a number.
        last = numbers[-1]
        return f"{mean:.2f}{last.suffix}" if last.text else mean

    text = [value for value in values if isinstance(value, str)]

    if not text:
        return None

    # A vendor or device name, or an empty reading from a GPU that has none
    return next((value for value in reversed(text) if value), text[-1])


def bucket_seconds(window: int, points: int = MAX_POINTS) -> int:
    """Pick the bucket size that draws `window` in about `points` points."""
    wanted = window / max(points, 1)
    return next((size for size in BUCKET_LADDER if size >= wanted), BUCKET_LADDER[-1])


def save_sample(
    stats: dict[str, Any],
    retain_days: int,
    path: Path = HISTORY_PATH,
    now: float | None = None,
) -> None:
    """Store one minute of metrics, roll up what has aged, prune the rest.

    Args:
        stats: A stats snapshot, as `/stats` returns it.
        retain_days: Days of history to keep.
        path: The history database.
        now: The sample's time, for tests.
    """
    moment = time.time() if now is None else now
    data = json.dumps(select_metrics(stats), allow_nan=False)

    # `closing` shuts the connection; `with db` commits the whole minute
    with closing(sqlite3.connect(path, timeout=2)) as db, db:
        db.execute(_CREATE_TABLE)
        db.execute(
            "INSERT OR REPLACE INTO samples VALUES (?, ?, ?)",
            (TIERS[0].seconds, int(moment // TIERS[0].seconds), data),
        )
        _compact(db, moment)
        db.execute(
            "DELETE FROM samples WHERE bucket * resolution < ?",
            (moment - retain_days * 86400,),
        )


def _compact(db: sqlite3.Connection, now: float) -> None:
    """Roll aged rows into the next tier, one whole target bucket at a time."""
    for tier, coarser in zip(TIERS, TIERS[1:]):
        assert tier.keep is not None
        limit = now - tier.keep
        rows = db.execute(
            "SELECT bucket, data FROM samples WHERE resolution = ? AND bucket < ?",
            (tier.seconds, int(limit // tier.seconds)),
        ).fetchall()

        groups: dict[int, list[dict]] = {}

        for bucket, data in rows:
            target = (bucket * tier.seconds) // coarser.seconds

            # Wait until the target bucket has closed and has aged past the
            # limit, so it is written once from all of its rows instead of
            # being overwritten by each minute that crosses the boundary.
            if (target + 1) * coarser.seconds > limit:
                continue

            groups.setdefault(target, []).append(json.loads(data))

        for target, samples in groups.items():
            db.execute(
                "INSERT OR REPLACE INTO samples VALUES (?, ?, ?)",
                (
                    coarser.seconds,
                    target,
                    json.dumps(merge_samples(samples), allow_nan=False),
                ),
            )
            db.execute(
                "DELETE FROM samples WHERE resolution = ? AND bucket >= ? AND bucket < ?",
                (
                    tier.seconds,
                    target * coarser.seconds // tier.seconds,
                    (target + 1) * coarser.seconds // tier.seconds,
                ),
            )


def read_history(
    window: int,
    points: int = MAX_POINTS,
    path: Path = HISTORY_PATH,
    now: float | None = None,
) -> tuple[list[dict], int]:
    """Read the last `window` seconds as evenly spaced samples.

    Args:
        window: Seconds of history to return.
        points: About how many samples to return.
        path: The history database.
        now: The end of the window, for tests.

    Returns:
        The samples, oldest first, and the seconds each one covers. Every
        sample carries the bucket's start time as `service.last_updated`, so
        the graphs label it the way they label a live sample.
    """
    if not path.exists():
        return [], bucket_seconds(window, points)

    moment = time.time() if now is None else now
    size = bucket_seconds(window, points)
    groups: dict[int, list[dict]] = {}

    with closing(
        sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=2)
    ) as db:
        rows = db.execute(
            "SELECT bucket * resolution, data FROM samples"
            " WHERE bucket * resolution >= ? ORDER BY 1",
            (moment - window,),
        )

        for started, data in rows:
            groups.setdefault(int(started // size), []).append(json.loads(data))

    samples = []

    for bucket in sorted(groups):
        merged = merge_samples(groups[bucket])
        # The graphs read `detectors` and `processes` without a guard, so a
        # bucket that averaged to nothing still carries them, empty.
        samples.append(
            {
                "detectors": {},
                "processes": {},
                **merged,
                "service": {
                    **merged.get("service", {}),
                    "last_updated": bucket * size,
                },
            }
        )

    return samples, size
