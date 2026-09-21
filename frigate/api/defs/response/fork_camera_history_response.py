from pydantic import BaseModel, Field


class CameraHistoryIncident(BaseModel):
    """One outage or ffmpeg restart inside the requested window."""

    kind: str = Field(
        description="Incident kind: 'outage', or 'restart:<reason>' for an ffmpeg restart"
    )
    start: float = Field(description="Unix timestamp when the incident started")
    end: float | None = Field(
        default=None,
        description="Unix timestamp when it ended, null while it is ongoing",
    )
    reason: str = Field(description="Short reason reported by the capture process")


class CameraHistorySeries(BaseModel):
    """One camera's frame rate and health across the window's cells."""

    uptime: float = Field(
        description="Percentage of samples the camera was not offline"
    )
    downtime: float = Field(description="Seconds the camera was offline in the window")
    samples: int = Field(description="Stats samples that landed in the window")
    expected_fps: float = Field(description="Configured detect frame rate")
    fps: list[float | None] = Field(
        description="Mean frame rate per cell, null for a cell with no samples"
    )
    states: list[str] = Field(
        description="Worst state per cell: 'ok', 'degraded', 'offline' or 'none'"
    )
    incidents: list[CameraHistoryIncident] = Field(
        description="Incidents overlapping the window, oldest first"
    )


class CameraHistoryResponse(BaseModel):
    """Per-camera health history behind the System page's Health tab."""

    range: str = Field(
        description="Window that was returned: '1h', '6h', '24h' or '7d'"
    )
    start: float = Field(description="Unix timestamp of the window's first cell")
    end: float = Field(description="Unix timestamp of the window's end")
    cell_seconds: int = Field(description="Seconds each cell in fps/states covers")
    bucket_seconds: int = Field(description="Seconds of the collector's storage bucket")
    cameras: dict[str, CameraHistorySeries] = Field(
        description="History per camera the caller may see"
    )
