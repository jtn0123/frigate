"""Fork (D78): quiet hours windows for push notifications."""

from typing import Literal

from pydantic import Field, field_validator

from frigate.config.base import FrigateBaseModel

__all__ = ["WEEKDAYS", "QuietHoursWindow", "Weekday"]

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# Monday first, matching datetime.weekday()
WEEKDAYS: tuple[Weekday, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# 24 hour HH:MM, the format a browser time input produces
TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class QuietHoursWindow(FrigateBaseModel):
    days: list[Weekday] = Field(
        default_factory=list,
        title="Days",
        description="Days the window starts on. Leave empty for every day. A window that runs past midnight belongs to the day it starts on.",
    )
    start: str = Field(
        pattern=TIME_PATTERN,
        title="Start time",
        description="Time the window starts, as HH:MM in 24 hour time.",
    )
    end: str = Field(
        pattern=TIME_PATTERN,
        title="End time",
        description="Time the window ends, as HH:MM in 24 hour time. An end at or before the start runs past midnight into the next day.",
    )

    @field_validator("days")
    @classmethod
    def _sort_days(cls, days: list[Weekday]) -> list[Weekday]:
        """Drop repeated days and keep them in week order."""
        chosen = set(days)
        return [day for day in WEEKDAYS if day in chosen]
