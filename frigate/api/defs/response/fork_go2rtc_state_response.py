from pydantic import BaseModel, Field


class Go2rtcStreamState(BaseModel):
    """One go2rtc stream a camera depends on, without its source URL."""

    name: str = Field(description="go2rtc stream name")
    configured: bool = Field(description="Whether go2rtc has a stream by this name")
    connected: bool = Field(
        description="Whether any producer has tracks or has received bytes"
    )
    bytes_received: int = Field(description="Bytes received across all producers")
    bytes_per_second: float | None = Field(
        default=None,
        description="Receive rate since the previous sample, null when there is none",
    )
    producers: int = Field(description="Number of sources go2rtc lists")
    consumers: int = Field(description="Number of readers currently attached")
    codecs: list[str] = Field(description="Codecs the connected producers offer")
    source: str | None = Field(
        default=None,
        description="Scheme and host of the source, never credentials, path or query",
    )


class Go2rtcCameraState(BaseModel):
    """The go2rtc streams of one camera."""

    streams: list[Go2rtcStreamState] = Field(
        description="Streams named by live.streams, the ffmpeg inputs or the camera"
    )


class Go2rtcStateResponse(BaseModel):
    """Per-camera go2rtc source state behind the Health drawer."""

    available: bool = Field(description="Whether go2rtc answered")
    updated: float = Field(description="Unix timestamp the state was read")
    cameras: dict[str, Go2rtcCameraState] = Field(
        description="State per camera the caller may see, empty when unavailable"
    )
