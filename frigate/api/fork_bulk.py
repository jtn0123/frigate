"""Bounded-query helpers for the explore summary."""

from peewee import fn

from frigate.models import Event

# the columns the /events/explore response is built from; the thumbnail BLOB
# and the other unused columns stay in the database
EXPLORE_COLUMNS = (
    Event.id,
    Event.camera,
    Event.label,
    Event.zones,
    Event.start_time,
    Event.end_time,
    Event.has_clip,
    Event.has_snapshot,
    Event.plus_id,
    Event.retain_indefinitely,
    Event.sub_label,
    Event.top_score,
    Event.false_positive,
    Event.box,
    Event.data,
)


def explore_recent_events(allowed_cameras: list[str], limit: int) -> list[Event]:
    """Get the most recent `limit` events of every label in one query.

    Rows come back ordered by label, then newest first, which is the order the
    per-label queries this replaces produced. Each event carries `event_count`,
    the number of events with its label on the allowed cameras, taken from the
    same snapshot as the rows. A negative limit means no limit, as it does for
    a SQL LIMIT.

    Args:
        allowed_cameras: Cameras the current user may see
        limit: Maximum number of events per label

    Returns:
        Events carrying only the columns in `EXPLORE_COLUMNS` and `event_count`
    """
    ranked = (
        Event.select(
            Event.id.alias("event_id"),
            fn.ROW_NUMBER()
            .over(partition_by=[Event.label], order_by=[Event.start_time.desc()])
            .alias("row_number"),
            fn.COUNT(Event.id).over(partition_by=[Event.label]).alias("event_count"),
        )
        .where(Event.camera << allowed_cameras)
        .alias("ranked")
    )
    query = Event.select(*EXPLORE_COLUMNS, ranked.c.event_count).join(
        ranked, on=(Event.id == ranked.c.event_id)
    )

    if limit >= 0:
        query = query.where(ranked.c.row_number <= limit)

    return list(query.order_by(Event.label, ranked.c.row_number).objects())
