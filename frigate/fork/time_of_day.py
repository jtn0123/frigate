"""Time-of-day filter for event queries that honors DST (fork B36)."""

import operator
from datetime import datetime
from functools import reduce

from peewee import Expression, Field, fn

from frigate.util.time import get_dst_transitions


def time_of_day_clause(
    column: Field,
    time_range: str,
    tz_name: str | None,
    after: float | None = None,
    before: float | None = None,
) -> Expression:
    """Match rows whose local time of day falls in `time_range`.

    Each row is converted with the UTC offset in force at its own time rather
    than today's, and the start minute is included (08:00 matches 08:00:30).

    Args:
        column: The unix timestamp column to test
        time_range: "HH:MM,HH:MM"; an end before the start spans midnight
        tz_name: The browser's IANA time zone
        after: The query's lower bound, if any; else the column's oldest row
        before: The query's upper bound, if any; else now

    Returns:
        A clause for the query's where()
    """
    time_after, time_before = time_range.split(",")
    end = before or datetime.now().timestamp()
    start = after or column.model.select(fn.MIN(column)).scalar() or end
    branches = []
    periods = get_dst_transitions(tz_name or "utc", start, max(start, end))

    for index, (period_start, period_end, offset) in enumerate(periods):
        local = fn.strftime(
            "%H:%M", fn.datetime(column, "unixepoch", f"{int(offset)} seconds")
        )

        # overnight ranges, ex: from 20:00 to 06:00, are either side of midnight
        if time_after > time_before:
            branch = (local >= time_after) | (local < time_before)
        else:
            branch = (local >= time_after) & (local < time_before)

        # the outer periods stay open, so a row just outside [start, end]
        # still gets the nearest offset
        if index > 0:
            branch &= column >= period_start
        if index < len(periods) - 1:
            branch &= column < period_end

        branches.append(branch)

    clause: Expression = reduce(operator.or_, branches)
    return clause
