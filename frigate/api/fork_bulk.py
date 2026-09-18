"""Bounded-query helpers for the explore summary and the bulk delete routes."""

import logging
import os
from collections.abc import Iterator, Sequence
from functools import reduce
from pathlib import Path
from typing import Any

from peewee import fn, operator

from frigate.const import CLIPS_DIR
from frigate.embeddings import EmbeddingsContext
from frigate.models import Event, Recordings, ReviewSegment, Timeline, UserReviewStatus

logger = logging.getLogger(__name__)

# ids bound into one IN (...) list, far below SQLite's variable limit
ID_CHUNK_SIZE = 500
# review time ranges OR-ed into one recordings query (7 variables each)
REVIEW_RANGE_CHUNK_SIZE = 100

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


def chunked(items: Sequence[Any], size: int = ID_CHUNK_SIZE) -> Iterator[Sequence[Any]]:
    """Yield consecutive slices of at most `size` items."""
    for i in range(0, len(items), size):
        yield items[i : i + size]


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


def get_events_for_delete(event_ids: list[str]) -> dict[str, Event]:
    """Fetch the requested events in chunks, keyed by id.

    Only the columns the delete needs are read, so no thumbnails are loaded.
    """
    events: dict[str, Event] = {}

    for ids in chunked(list(dict.fromkeys(event_ids))):
        query = Event.select(Event.id, Event.camera, Event.has_snapshot).where(
            Event.id << ids
        )
        events.update({event.id: event for event in query})

    return events


def split_found_ids(
    event_ids: list[str], events: dict[str, Event]
) -> tuple[list[str], list[str]]:
    """Split the requested ids into found and not found, in request order.

    A repeated id is found once and not found after that, which is what
    deleting the ids one at a time reported.
    """
    found: dict[str, None] = {}
    not_found: list[str] = []

    for event_id in event_ids:
        if event_id in events and event_id not in found:
            found[event_id] = None
        else:
            not_found.append(event_id)

    return list(found), not_found


def delete_events_data(events: list[Event], context: EmbeddingsContext | None) -> None:
    """Remove the events' database rows, embeddings, and media files in batches.

    The rows go before the files (B11), as in delete_reviews_data, so that a
    failed query cannot leave events whose snapshots are already gone.
    """
    for ids in chunked([event.id for event in events]):
        Event.delete().where(Event.id << ids).execute()
        Timeline.delete().where(Timeline.source_id << ids).execute()

        # embeddings are always cleaned up, even when semantic search is
        # disabled, so that they don't outlive their events
        if context is not None:
            context.db.delete_embeddings_thumbnail(event_ids=list(ids))
            context.db.delete_embeddings_description(event_ids=list(ids))

    for event in events:
        media_name = f"{event.camera}-{event.id}"
        if event.has_snapshot:
            snapshot_paths = [
                Path(f"{os.path.join(CLIPS_DIR, media_name)}.jpg"),
                Path(f"{os.path.join(CLIPS_DIR, media_name)}-clean.png"),
                Path(f"{os.path.join(CLIPS_DIR, media_name)}-clean.webp"),
            ]
            for media in snapshot_paths:
                try:
                    media.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Unable to delete snapshot %s", media, exc_info=True)


def _recordings_for_reviews(review_ids: list[str]) -> dict[str, str]:
    """Map id to path for every recording that overlaps one of the reviews."""
    reviews: list[dict[str, Any]] = []

    for ids in chunked(review_ids):
        reviews.extend(
            ReviewSegment.select(
                ReviewSegment.camera,
                ReviewSegment.start_time,
                ReviewSegment.end_time,
            )
            .where(ReviewSegment.id << ids)
            .dicts()
        )

    recordings: dict[str, str] = {}

    for part in chunked(reviews, REVIEW_RANGE_CHUNK_SIZE):
        clauses = [
            (Recordings.camera == review["camera"])
            & (
                Recordings.start_time.between(review["start_time"], review["end_time"])
                | Recordings.end_time.between(review["start_time"], review["end_time"])
                | (
                    (review["start_time"] > Recordings.start_time)
                    & (review["end_time"] < Recordings.end_time)
                )
            )
            for review in part
        ]
        query = (
            Recordings.select(Recordings.id, Recordings.path)
            .where(reduce(operator.or_, clauses))
            .tuples()
        )
        recordings.update(dict(query))

    return recordings


def delete_reviews_data(review_ids: list[str]) -> None:
    """Delete review items with their recordings, database rows first.

    The rows go before the files so that a failed query cannot leave rows
    pointing at files that are already gone. A file that cannot be removed is
    logged and the rest are still removed.
    """
    recordings = _recordings_for_reviews(review_ids)

    for ids in chunked(list(recordings)):
        Recordings.delete().where(Recordings.id << ids).execute()

    for ids in chunked(review_ids):
        ReviewSegment.delete().where(ReviewSegment.id << ids).execute()
        UserReviewStatus.delete().where(
            UserReviewStatus.review_segment << ids
        ).execute()

    for path in recordings.values():
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            logger.warning("Unable to delete recording file %s", path, exc_info=True)
