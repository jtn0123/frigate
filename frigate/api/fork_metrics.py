"""Fork (I59): gather what the fork's Prometheus metrics are rendered from."""

from typing import Any

from fastapi import Request

from frigate.api.fork_go2rtc_state import get_reader
from frigate.fork.go2rtc_state import (
    camera_states,
    camera_stream_names,
    configured_sources,
)
from frigate.stats.fork_prometheus import fork_metrics
from frigate.stats.server_pressure import read_server_pressure

# The window `frigate_camera_uptime_ratio` reports.
UPTIME_WINDOW = "24h"


def fork_camera_metrics(request: Request, stats: dict[str, Any]) -> bytes:
    """Render the fork's metrics for one scrape of `/metrics`.

    The go2rtc state comes through the reader the Health drawer uses, so
    scrapes and open drawers share its five second cache. An unreachable
    go2rtc is reported as unavailable rather than failing the scrape.

    Args:
        request: The scrape, whose app holds the stats emitter, config and
            reader.
        stats: The stats snapshot this scrape already fetched.

    Returns:
        The exposition text, to append to upstream's.
    """
    app = request.app
    config = app.frigate_config
    go2rtc = camera_states(
        get_reader(app).read(),
        camera_stream_names(config),
        configured_sources(config),
    )
    return fork_metrics(
        stats,
        history=app.stats_emitter.camera_history.read(UPTIME_WINDOW),
        go2rtc=go2rtc,
        pressure=read_server_pressure(),
    )
