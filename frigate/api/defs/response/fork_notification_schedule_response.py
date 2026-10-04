from typing import Literal

from pydantic import BaseModel, Field


class QuietHoursCameraState(BaseModel):
    """Whether one camera's alert pushes are held back right now."""

    quiet: bool = Field(
        description="Whether review alert and trigger pushes are held back now"
    )
    windows: int = Field(description="Number of quiet hours windows the camera uses")


class NotificationScheduleResponse(BaseModel):
    """The clock quiet hours are read on, and each camera's state on it."""

    timezone: str = Field(description="IANA name of the timezone the windows use")
    source: Literal["ui", "server"] = Field(
        description="ui when ui.timezone is set, server for the server's local time"
    )
    now: float = Field(description="Unix timestamp the state was computed at")
    cameras: dict[str, QuietHoursCameraState] = Field(description="State per camera")
