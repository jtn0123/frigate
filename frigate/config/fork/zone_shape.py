"""Fork (D75, D76, D77): zone shape, line crossing direction and exclusion zones.

The fields are declared here and attached to the upstream ``ZoneConfig`` with
one line each, so the upstream hunk stays small. Line zones are two points
that objects cross (D75), optionally in one direction only (D76). Exclusion
zones are polygons where objects are tracked but never reviewed (D77).
"""

from typing import TYPE_CHECKING, Literal

from pydantic import Field

if TYPE_CHECKING:
    from frigate.config.camera.zone import ZoneConfig

ZoneType = Literal["polygon", "line"]
LineDirection = Literal["both", "a_to_b", "b_to_a"]

ZONE_TYPE_POLYGON: ZoneType = "polygon"
ZONE_TYPE_LINE: ZoneType = "line"
LINE_DIRECTION_BOTH: LineDirection = "both"
LINE_DIRECTION_A_TO_B: LineDirection = "a_to_b"
LINE_DIRECTION_B_TO_A: LineDirection = "b_to_a"

ZONE_TYPE_FIELD = Field(
    default=ZONE_TYPE_POLYGON,
    title="Zone type",
    description="polygon is an area an object is inside or outside of. line is a line of exactly two points that objects cross: an object enters the zone when its bottom center crosses the line, and inertia is the number of frames it must stay on the new side before the crossing counts. A line zone has no loitering time, speed estimation or exclusion.",
)

LINE_DIRECTION_FIELD = Field(
    default=LINE_DIRECTION_BOTH,
    title="Crossing direction",
    description="Which crossings of a line zone count. Side A is on the left of the line when looking from its first point to its second, side B on the right. both counts crossings either way, a_to_b only crossings from side A to side B, and b_to_a only crossings from side B to side A. Only valid on line zones.",
)

EXCLUSION_FIELD = Field(
    default=False,
    title="Exclusion zone",
    description="Objects in an exclusion zone are still tracked and listed in Explore, but while an object is inside one and has entered only exclusion zones, it does not start, extend or upgrade an alert or detection. Before it walks in, it is reviewed as usual, so cover the area where objects first appear. An object that also enters a normal zone or crosses a line is reviewed as usual. Unlike an object mask, an exclusion zone does not drop detections, so tracks through it are not broken. Only valid on polygon zones.",
)


def count_points(coordinates: str | list[str]) -> int:
    """Return the number of points in a zone's coordinates.

    Args:
        coordinates: A flat "x1,y1,x2,y2" string or a list of "x,y" strings.

    Returns:
        The number of points, or 0 when there are none.
    """
    if isinstance(coordinates, str):
        values = [value for value in coordinates.split(",") if value.strip()]
        return len(values) // 2

    return len(coordinates)


def validate_zone_shape(zone: "ZoneConfig") -> None:
    """Reject settings that make no sense for the zone's type.

    Args:
        zone: The zone being validated.

    Raises:
        ValueError: When a line zone does not have exactly two points or sets
            a polygon-only option, or a polygon zone sets a direction.
    """
    if zone.type == ZONE_TYPE_LINE:
        points = count_points(zone.coordinates)

        if points != 2:
            raise ValueError(f"a line zone must have exactly 2 points, not {points}")

        if zone.distances:
            raise ValueError("distances (speed estimation) do not apply to a line zone")

        if zone.speed_threshold is not None:
            raise ValueError("speed_threshold does not apply to a line zone")

        if zone.loitering_time > 0:
            raise ValueError("loitering_time does not apply to a line zone")

        if zone.exclusion:
            raise ValueError("a line zone can not be an exclusion zone")
    elif zone.direction != LINE_DIRECTION_BOTH:
        raise ValueError("direction only applies to a line zone (type: line)")
