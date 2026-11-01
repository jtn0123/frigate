from enum import Enum

from pydantic import BaseModel, Field


class Extension(str, Enum):
    webp = "webp"
    png = "png"
    jpg = "jpg"
    jpeg = "jpeg"

    def get_mime_type(self) -> str:
        if self in (Extension.jpg, Extension.jpeg):
            return "image/jpeg"
        return f"image/{self.value}"


class MediaLatestFrameQueryParams(BaseModel):
    bbox: int | None = None
    timestamp: int | None = None
    zones: int | None = None
    mask: int | None = None
    motion: int | None = None
    paths: int | None = None
    regions: int | None = None
    quality: int | None = 70
    height: int | None = None
    store: int | None = None


class MediaEventsSnapshotQueryParams(BaseModel):
    download: bool | None = False
    timestamp: int | None = None
    bbox: int | None = None
    crop: int | None = None
    height: int | None = None
    quality: int | None = None


class MediaMjpegFeedQueryParams(BaseModel):
    # the stream sleeps 1 / fps and scales by height, so neither may be 0
    fps: int = Field(3, ge=1, le=30)
    height: int = Field(360, ge=16)
    bbox: int | None = None
    timestamp: int | None = None
    zones: int | None = None
    mask: int | None = None
    motion: int | None = None
    regions: int | None = None
