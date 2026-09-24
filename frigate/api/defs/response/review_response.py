from datetime import date, datetime

from pydantic import BaseModel, Json, RootModel

from frigate.review.types import SeverityEnum


class ReviewSegmentResponse(BaseModel):
    id: str
    camera: str
    start_time: datetime
    end_time: datetime
    has_been_reviewed: bool
    severity: SeverityEnum
    thumb_path: str
    data: Json


class Last24HoursReview(BaseModel):
    reviewed_alert: int | None
    reviewed_detection: int | None
    total_alert: int | None
    total_detection: int | None


class DayReview(BaseModel):
    day: date
    reviewed_alert: int
    reviewed_detection: int
    total_alert: int
    total_detection: int


class ReviewSummaryResponse(RootModel[dict[str, Last24HoursReview | DayReview]]):
    """Review counts for the last 24 hours and each date."""


class ReviewActivityMotionResponse(BaseModel):
    start_time: int
    motion: float
    camera: str
