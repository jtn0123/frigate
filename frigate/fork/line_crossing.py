"""Fork (D75, D76): line zones are crossed, not occupied.

A line zone has two points, P1 and P2. Side A is on the left of the line when
looking from P1 to P2 in image coordinates (y grows downward) and side B is on
the right; the web editor labels the sides with the same rule. The sign of the
cross product (P2 - P1) x (P - P1) says which side a point P is on, and it
does not change when either axis is scaled, so relative and pixel coordinates
agree.

Each frame, the object's bottom center is fed to every line zone. A crossing
counts when the object has been seen on one side, then stays on the other side
for ``inertia`` frames, and the step from its last position on the old side to
its first position on the new side passes through the segment between the two
points (walking around the end of the line is not a crossing). On a counted
crossing in an allowed direction the line's name joins ``entered_zones`` like
any zone, so required zones, Event.zones, the ``/events?zones=`` filter, MQTT
and review need nothing new. Each counted crossing also puts the line in the
object's current zones for ``LINE_CROSSING_HOLD_SECONDS``: zone occupancy
(MQTT ``frigate/<zone>/<label>``) and review's required zones read current
zones, so a crossing shows there as a short pulse, and an object that crossed
and is still in view is not counted as standing on the line.

The work per object and frame is a few multiplications per line zone.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from frigate.config.fork.zone_shape import (
    LINE_DIRECTION_A_TO_B,
    LINE_DIRECTION_B_TO_A,
    ZONE_TYPE_LINE,
)

if TYPE_CHECKING:
    from frigate.config.camera.zone import ZoneConfig
    from frigate.track.tracked_object import TrackedObject

Point = tuple[float, float]

SIDE_A = -1
SIDE_B = 1

# how long a counted crossing keeps the line in the object's current zones
LINE_CROSSING_HOLD_SECONDS = 2.0


def side_of_line(p1: Point, p2: Point, point: Point) -> int:
    """Return which side of the line through p1 and p2 a point is on.

    Args:
        p1: The line's first point.
        p2: The line's second point.
        point: The point to place.

    Returns:
        SIDE_A, SIDE_B, or 0 when the point lies exactly on the line.
    """
    cross = (p2[0] - p1[0]) * (point[1] - p1[1]) - (p2[1] - p1[1]) * (point[0] - p1[0])

    if cross > 0:
        return SIDE_B

    if cross < 0:
        return SIDE_A

    return 0


def _on_segment(start: Point, end: Point, point: Point) -> bool:
    """Whether a point known to be collinear with a segment lies on it."""
    return min(start[0], end[0]) <= point[0] <= max(start[0], end[0]) and min(
        start[1], end[1]
    ) <= point[1] <= max(start[1], end[1])


def segments_intersect(p1: Point, p2: Point, q1: Point, q2: Point) -> bool:
    """Return whether segment p1-p2 meets segment q1-q2.

    Touching counts, including an endpoint landing exactly on the other
    segment. Collinear segments meet only when they overlap.

    Args:
        p1: First segment's start.
        p2: First segment's end.
        q1: Second segment's start.
        q2: Second segment's end.

    Returns:
        True when the segments share at least one point.
    """
    o1 = side_of_line(p1, p2, q1)
    o2 = side_of_line(p1, p2, q2)
    o3 = side_of_line(q1, q2, p1)
    o4 = side_of_line(q1, q2, p2)

    if o1 != o2 and o3 != o4:
        return True

    return (
        (o1 == 0 and _on_segment(p1, p2, q1))
        or (o2 == 0 and _on_segment(p1, p2, q2))
        or (o3 == 0 and _on_segment(q1, q2, p1))
        or (o4 == 0 and _on_segment(q1, q2, p2))
    )


def direction_allows(direction: str, crossing: int) -> bool:
    """Return whether a crossing toward ``crossing`` counts for a direction.

    Args:
        direction: The line's direction: both, a_to_b or b_to_a.
        crossing: The side the object crossed into, SIDE_A or SIDE_B.

    Returns:
        True when the crossing counts.
    """
    if direction == LINE_DIRECTION_A_TO_B:
        return crossing == SIDE_B

    if direction == LINE_DIRECTION_B_TO_A:
        return crossing == SIDE_A

    return crossing != 0


@dataclass(slots=True)
class LineState:
    """One object's position relative to one line zone."""

    side: int = 0
    anchor: Point | None = None
    pending_side: int = 0
    pending_frames: int = 0
    pending_crossed: bool = False
    crossed_at: float | None = None

    def update(self, p1: Point, p2: Point, point: Point, inertia: int) -> int:
        """Feed one position and report a confirmed crossing.

        Args:
            p1: The line's first point.
            p2: The line's second point.
            point: The object's bottom center this frame.
            inertia: Frames the object must stay on the new side.

        Returns:
            SIDE_B for a crossing from side A to side B, SIDE_A for the
            reverse, or 0 when nothing was confirmed this frame.
        """
        side = side_of_line(p1, p2, point)

        # exactly on the line: wait until the object picks a side
        if side == 0:
            return 0

        if self.side == 0:
            self.side = side
            self.anchor = point
            return 0

        if side == self.side:
            # back on the confirmed side, so a pending crossing was jitter
            self.anchor = point
            self.pending_side = 0
            self.pending_frames = 0
            self.pending_crossed = False
            return 0

        if self.pending_side != side:
            self.pending_side = side
            self.pending_frames = 0
            self.pending_crossed = self.anchor is not None and segments_intersect(
                self.anchor, point, p1, p2
            )

        self.pending_frames += 1

        if self.pending_frames < max(inertia, 1):
            return 0

        crossed = self.pending_crossed
        self.side = side
        self.anchor = point
        self.pending_side = 0
        self.pending_frames = 0
        self.pending_crossed = False
        return side if crossed else 0


def is_line_zone(zone: "ZoneConfig") -> bool:
    """Return whether a zone is a line zone."""
    return zone.type == ZONE_TYPE_LINE


def update_line_zone(
    obj: "TrackedObject",
    name: str,
    zone: "ZoneConfig",
    point: Point,
    frame_time: float,
) -> bool:
    """Feed an object's bottom center to one line zone.

    Called from the per-object zone loop in ``TrackedObject.update`` for
    enabled line zones that apply to the object's label.

    Args:
        obj: The tracked object; its ``line_states`` hold the per-line state.
        name: The zone's name.
        zone: The line zone.
        point: The object's bottom center in detect pixels.
        frame_time: The current frame's time.

    Returns:
        Whether the line belongs in the object's current zones, which is
        true for ``LINE_CROSSING_HOLD_SECONDS`` after each counted crossing.
    """
    contour = zone.contour

    if len(contour) != 2:
        return False

    state = obj.line_states.get(name)

    if state is None:
        state = obj.line_states[name] = LineState()

    p1 = (float(contour[0][0]), float(contour[0][1]))
    p2 = (float(contour[1][0]), float(contour[1][1]))
    crossing = state.update(p1, p2, point, zone.inertia)

    if crossing and direction_allows(zone.direction, crossing):
        if name in obj.entered_zones:
            # its zone filters already passed on the first crossing
            state.crossed_at = frame_time
        else:
            # imported here: tracked_object imports this module
            from frigate.track.tracked_object import zone_filtered

            if not zone_filtered(obj, zone.filters):
                obj.entered_zones.append(name)
                obj.new_zone_entered = True
                state.crossed_at = frame_time

    return (
        state.crossed_at is not None
        and frame_time - state.crossed_at < LINE_CROSSING_HOLD_SECONDS
    )


def _arrow_vectors(
    p1: Point, p2: Point
) -> tuple[Point, tuple[float, float], float] | None:
    """Midpoint, unit normal toward side B, and arrow length for a line."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    length = (dx * dx + dy * dy) ** 0.5

    if length < 1:
        return None

    mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    normal = (-dy / length, dx / length)
    return mid, normal, min(max(length * 0.15, 24.0), 80.0)


def draw_line_zone(
    frame: np.ndarray,
    zone: "ZoneConfig",
    color: tuple[int, int, int],
    thickness: int,
) -> None:
    """Draw a line zone with its side labels and allowed direction.

    Args:
        frame: The BGR debug frame to draw on.
        zone: The line zone.
        color: Line color.
        thickness: Line thickness; thicker while an object is on the line.
    """
    contour = zone.contour

    if len(contour) != 2:
        return

    p1 = (int(contour[0][0]), int(contour[0][1]))
    p2 = (int(contour[1][0]), int(contour[1][1]))
    cv2.line(frame, p1, p2, color, thickness)
    vectors = _arrow_vectors(p1, p2)

    if vectors is None:
        return

    mid, normal, size = vectors

    def along(distance: float) -> tuple[int, int]:
        # a point on the normal through the midpoint, positive toward side B
        return (int(mid[0] + normal[0] * distance), int(mid[1] + normal[1] * distance))

    if zone.direction == LINE_DIRECTION_A_TO_B:
        arrows = [(along(-size), along(size))]
    elif zone.direction == LINE_DIRECTION_B_TO_A:
        arrows = [(along(size), along(-size))]
    else:
        arrows = [(along(0), along(size)), (along(0), along(-size))]

    for start, end in arrows:
        cv2.arrowedLine(
            frame, start, end, color, max(2, thickness // 2), tipLength=0.35
        )

    for label, distance in (("A", -size - 14), ("B", size + 14)):
        x, y = along(distance)
        cv2.putText(
            frame,
            label,
            (x - 6, y + 6),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            color,
            2,
            cv2.LINE_AA,
        )


def draw_exclusion_zone(frame: np.ndarray, zone: "ZoneConfig", thickness: int) -> None:
    """Draw an exclusion zone as a red outline with diagonal hatching.

    Args:
        frame: The BGR debug frame to draw on.
        zone: The exclusion zone.
        thickness: Outline thickness.
    """
    contour = zone.contour

    if len(contour) < 3:
        return

    red = (40, 40, 220)
    x, y, w, h = cv2.boundingRect(contour.astype(np.int32))
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, frame.shape[1]), min(y + h, frame.shape[0])

    if x1 > x0 and y1 > y0:
        inside = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillPoly(inside, [contour.astype(np.int32) - [x0, y0]], (255,))
        hatch = np.zeros_like(inside)
        span = inside.shape[0] + inside.shape[1]

        for offset in range(-inside.shape[0], span, 18):
            cv2.line(
                hatch,
                (offset, 0),
                (offset + inside.shape[0], inside.shape[0]),
                (255,),
                2,
            )

        region = frame[y0:y1, x0:x1]
        region[(hatch > 0) & (inside > 0)] = red

    cv2.drawContours(frame, [contour], -1, red, thickness)


def draw_fork_zone(frame: np.ndarray, zone: "ZoneConfig", thickness: int) -> bool:
    """Draw a line or exclusion zone on the debug frame.

    Args:
        frame: The BGR debug frame.
        zone: Any zone.
        thickness: The thickness upstream picked for the zone.

    Returns:
        True when the zone was drawn here, False for a plain polygon zone
        that the caller draws as before.
    """
    if zone.type == ZONE_TYPE_LINE:
        draw_line_zone(frame, zone, zone.color, thickness)
        return True

    if zone.exclusion:
        draw_exclusion_zone(frame, zone, thickness)
        return True

    return False


def line_zone_names(zones: dict[str, Any]) -> list[str]:
    """Return the names of the line zones in a camera's zones."""
    return [name for name, zone in zones.items() if zone.type == ZONE_TYPE_LINE]
