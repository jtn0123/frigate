from pydantic import Field

from .base import FrigateBaseModel

__all__ = ["TelemetryConfig", "StatsConfig", "StatsHistoryConfig"]


class StatsHistoryConfig(FrigateBaseModel):
    """Fork (D54): system metrics kept past the in-memory stats window."""

    enabled: bool = Field(
        default=True,
        title="System metrics history",
        description="Store a sample of system metrics every minute so the System page can graph windows longer than the 20 minutes held in memory.",
    )
    retain_days: int = Field(
        default=30,
        ge=1,
        le=365,
        title="System metrics history retention",
        description="Days of system metrics history to keep. Samples are rolled up as they age, so a month is a few thousand rows.",
    )


class StatsConfig(FrigateBaseModel):
    amd_gpu_stats: bool = Field(
        default=True,
        title="AMD GPU stats",
        description="Enable collection of AMD GPU statistics if an AMD GPU is present.",
    )
    intel_gpu_stats: bool = Field(
        default=True,
        title="Intel GPU stats",
        description="Enable collection of Intel GPU statistics if an Intel GPU is present.",
    )
    network_bandwidth: bool = Field(
        default=False,
        title="Network bandwidth",
        description="Enable per-process network bandwidth monitoring for camera ffmpeg processes and detectors (requires capabilities).",
    )
    history: StatsHistoryConfig = Field(
        default_factory=StatsHistoryConfig,
        title="System metrics history",
        description="Options for the stored history the System page graphs.",
    )
    intel_gpu_device: str | None = Field(
        default=None,
        title="Intel GPU device",
        description="PCI bus address or DRM device path (e.g. /dev/dri/card1) used to pin Intel GPU stats to a specific device when multiple are present.",
    )


class TelemetryConfig(FrigateBaseModel):
    network_interfaces: list[str] = Field(
        default=[],
        title="Network interfaces",
        description="List of network interface name prefixes to monitor for bandwidth statistics.",
    )
    stats: StatsConfig = Field(
        default_factory=StatsConfig,
        title="System stats",
        description="Options to enable/disable collection of various system and GPU statistics.",
    )
    version_check: bool = Field(
        default=True,
        title="Version check",
        description="Enable an outbound check to detect if a newer Frigate version is available.",
    )
