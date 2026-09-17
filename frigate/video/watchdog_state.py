"""Fork: the shared per-camera state the watchdog publishes for the stats process.

Each field is a multiprocessing manager proxy from `CameraMetrics`, or None in
tests. They travel as one value so the watchdog's constructor does not grow a
parameter for every fork feature (D11, D14, SV6).
"""

from typing import Any, NamedTuple


class WatchdogState(NamedTuple):
    restart_events: Any | None = None  # D11: ffmpeg restarts in the last 24 h
    hwaccel_fallback_since: Any | None = None  # D14: when it switched, or 0
    outage_events: Any | None = None  # SV6: unreachable/recovered in the last 24 h
    outage_since: Any | None = None  # SV6: when it went unreachable, or 0
