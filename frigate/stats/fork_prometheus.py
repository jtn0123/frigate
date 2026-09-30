"""Fork (I59): camera health, enrichment and memory metrics for Prometheus.

Upstream's collector exports the frame rates, detectors, GPUs and storage.
This adds what the fork tracks on top, so one scrape of `/api/metrics` holds
everything a dashboard or an alert rule needs: whether each camera is up and
for how long it has not been, restarts and outages, the capture watchdog's
age, go2rtc source state, enrichment speeds, and the container's memory with
its out of memory kills. This module only renders what it is given, so it
stays a pure function of its inputs. Unknown values are left out rather than
exported as zero.
"""

import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from prometheus_client import CollectorRegistry, Gauge, generate_latest

CGROUP_DIR = Path("/sys/fs/cgroup")
CAMERA = ["camera_name"]
QUALITIES = ("excellent", "fair", "poor", "unusable")
# Below this a camera counts as delivering nothing, as on the Health tab.
OFFLINE_FPS = 0.1
PRESSURE_FIELDS = (
    "memory_bytes",
    "memory_limit_bytes",
    "swap_bytes",
    "swap_limit_bytes",
    "cpu_percent",
    "memory_pressure",
    "cpu_pressure",
    "io_pressure",
    "oom_kills",
)


def number(value: object) -> float | None:
    """Return a finite number, or None for anything else (bools included)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def camera_up(camera: Mapping[str, Any]) -> bool:
    """Say whether a camera is delivering frames right now."""
    fps = number(camera.get("camera_fps")) or 0.0
    return fps >= OFFLINE_FPS and not camera.get("outage_since")


def read_cgroup(directory: Path = CGROUP_DIR) -> dict[str, float]:
    """Read the container's memory use, limit and out of memory kills.

    Returns only what the cgroup v2 files provide: no limit is reported when
    it is `max`, and nothing at all outside cgroup v2.
    """
    values: dict[str, float] = {}
    for key, name in (
        ("memory_bytes", "memory.current"),
        ("limit_bytes", "memory.max"),
    ):
        try:
            values[key] = float((directory / name).read_text().strip())
        except (OSError, ValueError):
            continue
    try:
        events = (directory / "memory.events").read_text().splitlines()
    except OSError:
        events = []
    for line in events:
        name, _, count = line.partition(" ")
        if name == "oom_kill" and count.strip().isdigit():
            values["oom_kills"] = float(count)
    return values


class _Families:
    """Create each gauge on first use, so unused ones are not exported."""

    def __init__(self) -> None:
        self.registry = CollectorRegistry()
        self.gauges: dict[str, Gauge] = {}

    def set(
        self,
        name: str,
        description: str,
        value: object,
        labels: Mapping[str, str] | None = None,
    ) -> None:
        result = number(value)
        if result is None:
            return
        labels = labels or {}
        gauge = self.gauges.get(name)
        if gauge is None:
            gauge = Gauge(name, description, list(labels), registry=self.registry)
            self.gauges[name] = gauge
        if labels:
            gauge.labels(**labels).set(result)
        else:
            gauge.set(result)


def _cameras(
    families: _Families, cameras: Mapping[str, Any], now: float | None = None
) -> None:
    for name, camera in cameras.items():
        if not isinstance(camera, Mapping):
            continue
        label = {"camera_name": str(name)}
        families.set(
            "frigate_camera_up",
            "1 while the camera delivers frames and is not in an outage",
            int(camera_up(camera)),
            label,
        )
        families.set(
            "frigate_camera_expected_fps",
            "Configured detect frame rate",
            camera.get("expected_fps"),
            label,
        )
        families.set(
            "frigate_camera_skipped_percent",
            "Percent of frames dropped before detection",
            camera.get("skipped_pct"),
            label,
        )
        since = number(camera.get("outage_since"))
        if now is not None:
            families.set(
                "frigate_camera_outage_seconds",
                "Seconds the camera has been unreachable, 0 when it is not",
                max(0.0, now - since) if since else 0,
                label,
            )
        families.set(
            "frigate_camera_outages_24h",
            "Outages that started in the last 24 hours",
            camera.get("outages_24h"),
            label,
        )
        families.set(
            "frigate_camera_restarts_24h",
            "ffmpeg and capture restarts in the last 24 hours",
            camera.get("restarts_24h"),
            label,
        )
        kinds = camera.get("restart_kinds_24h")
        for kind, count in kinds.items() if isinstance(kinds, Mapping) else ():
            families.set(
                "frigate_camera_restarts_by_kind_24h",
                "Restarts in the last 24 hours by cause",
                count,
                {**label, "kind": str(kind)},
            )
        families.set(
            "frigate_camera_reconnects_last_hour",
            "Detect stream reconnects in the last hour",
            camera.get("reconnects_last_hour"),
            label,
        )
        families.set(
            "frigate_camera_stalls_last_hour",
            "Detect stream stalls in the last hour",
            camera.get("stalls_last_hour"),
            label,
        )
        quality = camera.get("connection_quality")
        if quality in QUALITIES:
            for candidate in QUALITIES:
                families.set(
                    "frigate_camera_connection_quality",
                    "1 for the camera's current connection quality",
                    int(candidate == quality),
                    {**label, "quality": candidate},
                )
        if isinstance(camera.get("hwaccel_fallback"), bool):
            families.set(
                "frigate_camera_hwaccel_fallback",
                "1 while detect decodes in software after hardware decoding failed",
                int(camera["hwaccel_fallback"]),
                label,
            )
        families.set(
            "frigate_camera_watchdog_age_seconds",
            "Seconds since the camera's capture watchdog last ran",
            camera.get("watchdog_age"),
            label,
        )


def _history(families: _Families, history: Mapping[str, Any] | None) -> None:
    if not history:
        return
    window = str(history.get("range", ""))
    cameras = history.get("cameras")
    for name, camera in cameras.items() if isinstance(cameras, Mapping) else ():
        if not isinstance(camera, Mapping) or not camera.get("samples"):
            continue
        uptime = number(camera.get("uptime"))
        if uptime is not None:
            families.set(
                "frigate_camera_uptime_ratio",
                "Share of the window the camera was delivering frames (0.0 - 1.0)",
                uptime / 100,
                {"camera_name": str(name), "window": window},
            )


def _go2rtc(families: _Families, state: Mapping[str, Any] | None) -> None:
    if not state:
        return
    families.set(
        "frigate_go2rtc_available",
        "1 while go2rtc answers",
        int(bool(state.get("available"))),
    )
    cameras = state.get("cameras")
    for name, camera in cameras.items() if isinstance(cameras, Mapping) else ():
        for stream in camera.get("streams", []) if isinstance(camera, Mapping) else []:
            label = {"camera_name": str(name), "stream": str(stream.get("name", ""))}
            families.set(
                "frigate_go2rtc_stream_connected",
                "1 while go2rtc has a connected source for the stream",
                int(bool(stream.get("connected"))),
                label,
            )
            families.set(
                "frigate_go2rtc_stream_received_bytes",
                "Bytes go2rtc received from the stream's sources since they connected",
                stream.get("bytes_received"),
                label,
            )
            families.set(
                "frigate_go2rtc_stream_consumers",
                "Readers attached to the stream",
                stream.get("consumers"),
                label,
            )


def _enrichments(families: _Families, embeddings: Mapping[str, Any]) -> None:
    for key, value in embeddings.items():
        key = str(key)
        if key.endswith("_speed"):
            speed = number(value)
            families.set(
                "frigate_enrichment_speed_seconds",
                "Time one enrichment inference takes",
                None if speed is None else speed / 1000,
                {"name": key.removesuffix("_speed")},
            )
        else:
            families.set(
                "frigate_enrichment_per_second",
                "Enrichment inferences per second",
                value,
                {"name": key.removesuffix("_events_per_second")},
            )


def _memory(
    families: _Families,
    cgroup: Mapping[str, float],
    pressure: Mapping[str, Any] | None,
) -> None:
    families.set(
        "frigate_container_memory_bytes",
        "Memory the Frigate container uses",
        cgroup.get("memory_bytes"),
    )
    families.set(
        "frigate_container_memory_limit_bytes",
        "Memory limit of the Frigate container, absent when unlimited",
        cgroup.get("limit_bytes"),
    )
    families.set(
        "frigate_container_oom_kills",
        "Processes in the Frigate container the kernel killed to free memory",
        cgroup.get("oom_kills"),
    )
    scopes = (pressure or {}).get("scopes")
    for scope in scopes if isinstance(scopes, list) else []:
        label = {"scope": str(scope.get("scope", "")), "id": str(scope.get("id", ""))}
        for field in PRESSURE_FIELDS:
            families.set(
                f"frigate_server_{field}",
                f"Host collector: {field.replace('_', ' ')}",
                scope.get(field),
                label,
            )


def fork_metrics(
    stats: Mapping[str, Any],
    history: Mapping[str, Any] | None = None,
    go2rtc: Mapping[str, Any] | None = None,
    pressure: Mapping[str, Any] | None = None,
    cgroup: Mapping[str, float] | None = None,
) -> bytes:
    """Render the fork's metrics in the Prometheus text format.

    Args:
        stats: The latest stats snapshot.
        history: `CameraHistory.read` for the window to report uptime over.
        go2rtc: The per-camera go2rtc state, as the Health drawer gets it.
        pressure: `read_server_pressure`, when the host collector is set up.
        cgroup: The container's memory figures; read from the cgroup files
            when not given.

    Returns:
        The exposition text, to append to upstream's.
    """
    families = _Families()
    cameras = stats.get("cameras")
    service = stats.get("service")
    now = number(service.get("last_updated")) if isinstance(service, Mapping) else None
    _cameras(families, cameras if isinstance(cameras, Mapping) else {}, now)
    _history(families, history)
    _go2rtc(families, go2rtc)
    embeddings = stats.get("embeddings")
    _enrichments(families, embeddings if isinstance(embeddings, Mapping) else {})
    _memory(families, read_cgroup() if cgroup is None else cgroup, pressure)
    return generate_latest(families.registry)
