from pydantic import BaseModel, Field


class LineCrossingCount(BaseModel):
    """Crossings of one line zone inside the requested window."""

    camera: str = Field(description="Camera the line belongs to")
    zone: str = Field(description="Name of the line zone")
    direction: str = Field(
        description="Direction the line counts: 'both', 'a_to_b' or 'b_to_a'"
    )
    total: int = Field(
        description="Tracked objects that crossed the line in a counted direction"
    )
    labels: dict[str, int] = Field(description="The same count split by label")


class LineCrossingsResponse(BaseModel):
    """Per-line crossing counts aggregated from stored tracked objects."""

    after: float = Field(description="Start of the window, Unix timestamp")
    before: float = Field(description="End of the window, Unix timestamp")
    lines: list[LineCrossingCount] = Field(
        description="One entry per line zone on the requested cameras, zero counts included"
    )
