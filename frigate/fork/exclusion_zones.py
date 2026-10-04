"""Fork (D77): exclusion zones, where objects are tracked but never reviewed.

An object mask drops detections before tracking, so a car passing behind one
loses its track. An exclusion zone keeps the detections and the track, and
only keeps the object out of review: while an object is inside one and has
entered exclusion zones and no other zone, it does not start, extend or
upgrade an alert or detection. The check runs per frame on where the object
is now, so the frames before it walks in, and after it walks out into an area
with no zone, are reviewed as usual. An object that also enters a normal zone
or crosses a line, or that never enters any zone, is reviewed as before.

Its ``max_severity`` is None, the same as an object outside a camera's
required zones, only while review has never seen it outside exclusion zones,
so the recording of an object that walks out is kept like any other.
"""

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

import cv2

if TYPE_CHECKING:
    from frigate.config import CameraConfig
    from frigate.config.camera.zone import ZoneConfig
    from frigate.track.tracked_object import TrackedObject


def exclusion_zone_names(zones: dict[str, "ZoneConfig"]) -> set[str]:
    """Return the names of a camera's enabled exclusion zones."""
    return {name for name, zone in zones.items() if zone.exclusion and zone.enabled}


def _bottom_center(box: Any) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2, float(box[3]))


def _stands_in_exclusion_zone(
    box: Any, label: str | None, zones: dict[str, "ZoneConfig"], names: set[str]
) -> bool:
    if box is None:
        return False

    point = _bottom_center(box)

    for name in names:
        zone = zones[name]

        if zone.objects and label not in zone.objects:
            continue

        if (
            len(zone.contour) >= 3
            and cv2.pointPolygonTest(zone.contour, point, False) >= 0
        ):
            return True

    return False


def excluded_now(
    current_zones: Iterable[str],
    entered_zones: Iterable[str],
    box: Any,
    label: str | None,
    zones: dict[str, "ZoneConfig"],
) -> bool:
    """Return whether review should skip an object this frame.

    An object is skipped while it is inside an exclusion zone and every zone
    it has entered is an exclusion zone. When it is in no zone this frame,
    its bottom center decides: zone inertia keeps it out of its zones for its
    first frames in one, and without this a car on an excluded road would
    start a review item before it entered the zone.

    Args:
        current_zones: The zones the object is in this frame.
        entered_zones: Every zone the object has entered.
        box: The object's box in detect pixels.
        label: The object's label.
        zones: The camera's zones.

    Returns:
        True when the object must not start or extend a review item.
    """
    names = exclusion_zone_names(zones)

    if not names or not set(entered_zones) <= names:
        # it entered a normal zone or crossed a line, which makes it reviewed
        return False

    current = set(current_zones)

    if current:
        return current <= names

    return _stands_in_exclusion_zone(box, label, zones, names)


def excluded_from_review(obj: dict[str, Any], camera_config: "CameraConfig") -> bool:
    """Return whether review should skip an object this frame.

    Args:
        obj: The tracked object as published to review.
        camera_config: The object's camera.

    Returns:
        True when the object must not start or extend a review item.
    """
    return excluded_now(
        obj.get("current_zones") or [],
        obj.get("entered_zones") or [],
        obj.get("box"),
        obj.get("label"),
        camera_config.zones,
    )


def _excluded_this_frame(obj: "TrackedObject") -> bool:
    return excluded_now(
        obj.current_zones,
        obj.entered_zones,
        obj.obj_data["box"],
        obj.obj_data["label"],
        obj.camera_config.zones,
    )


def note_review_frame(obj: "TrackedObject") -> None:
    """Remember once review has seen an object outside exclusion zones.

    Called at the end of ``TrackedObject.update``. Review skips false
    positives, so only a frame where the object is a true positive counts.

    Args:
        obj: The tracked object, with this frame's zones.
    """
    if obj.seen_outside_exclusion or obj.false_positive:
        return

    if not _excluded_this_frame(obj):
        obj.seen_outside_exclusion = True


def excluded_so_far(obj: "TrackedObject") -> bool:
    """Return whether review has only ever seen an object in exclusion zones.

    ``max_severity`` is None while this holds, so the object's recording is
    not kept for it; once it has been reviewed outside them, it is.

    Args:
        obj: The tracked object.

    Returns:
        True when the object has not been reviewable in any frame so far and
        is not reviewable now.
    """
    return not obj.seen_outside_exclusion and _excluded_this_frame(obj)
