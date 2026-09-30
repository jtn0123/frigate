from pydantic import BaseModel, Field


class LogSummaryGroup(BaseModel):
    """One message a camera repeated within one hour."""

    camera: str | None = Field(
        default=None,
        description="Camera the lines are about, null when none could be told",
    )
    service: str = Field(description="Log the lines came from: 'frigate' or 'go2rtc'")
    hour: float = Field(description="Unix timestamp of the start of the hour")
    level: str = Field(
        description="Highest level among the lines: 'info', 'warning' or 'error'"
    )
    count: int = Field(description="Lines in this group")
    first: float = Field(description="Unix timestamp of the first line")
    last: float = Field(description="Unix timestamp of the last line")
    message: str = Field(
        description="One example message, with URLs stripped of credentials "
        "and query strings, cut to about 200 characters"
    )
    signature: str = Field(
        description="The message with its numbers replaced, the same for "
        "every hour a message repeats in"
    )


class LogSummarySource(BaseModel):
    """How much of one service's log was read."""

    available: bool = Field(description="Whether the log file could be read")
    partial: bool = Field(
        description="True when only the end of the file was read because of its size"
    )
    lines: int = Field(description="Lines read from the file")
    covered_from: float | None = Field(
        default=None,
        description="Unix timestamp of the oldest line read, null without any",
    )
    covered_to: float | None = Field(
        default=None,
        description="Unix timestamp of the newest line read, null without any",
    )


class LogSummaryResponse(BaseModel):
    """Repeated warning and error log lines, collapsed per camera and hour."""

    hours: int = Field(description="Hours that were asked for")
    start: float = Field(description="Unix timestamp the requested window starts at")
    end: float = Field(description="Unix timestamp the requested window ends at")
    covered_from: float | None = Field(
        default=None,
        description="Unix timestamp the logs actually reach back to inside the "
        "window (they rotate by size), null when no log could be read",
    )
    sources: dict[str, LogSummarySource] = Field(
        description="What was read, per service"
    )
    total: int = Field(description="Lines counted, including ones left out of groups")
    unattributed: int = Field(description="Counted lines that name no camera")
    cameras: dict[str, int] = Field(
        description="Counted lines per camera, highest first"
    )
    truncated: bool = Field(
        description="True when there were more groups than are returned"
    )
    groups: list[LogSummaryGroup] = Field(
        description="Groups seen at least min_count times, highest count first"
    )
