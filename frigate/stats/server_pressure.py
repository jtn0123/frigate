"""Read a bounded host/CT collector snapshot without exposing process arguments."""

import json
import time
from pathlib import Path

from frigate.const import MODEL_CACHE_DIR
from frigate.stats.ai_models import number

PRESSURE_PATH = Path(MODEL_CACHE_DIR) / "server-telemetry.json"
FIELDS = (
    "memory_bytes",
    "memory_limit_bytes",
    "swap_bytes",
    "swap_limit_bytes",
    "cpu_percent",
    "cpu_limit",
    "memory_pressure",
    "cpu_pressure",
    "io_pressure",
    "oom_kills",
    "disk_free_bytes",
    "disk_total_bytes",
)


def read_server_pressure() -> dict:
    """Return whitelisted numeric fields with explicit scope and source age."""
    try:
        if PRESSURE_PATH.stat().st_size > 65536:
            return {"status": "invalid", "scopes": []}
        data = json.loads(PRESSURE_PATH.read_text())
        updated = number(data.get("updated"))
        fresh = updated is not None and 0 <= time.time() - updated <= 90
        scopes = []
        for entry in data.get("scopes", [])[:16]:
            kind = entry.get("scope")
            if kind not in {"host", "container", "ollama"}:
                continue
            scopes.append(
                {
                    "scope": kind,
                    "id": str(entry.get("id", ""))[:64],
                    **{
                        key: number(entry.get(key)) if fresh else None for key in FIELDS
                    },
                }
            )
        status = "partial" if data.get("status") == "partial" else "connected"
        if not fresh:
            status = "stale"
        return {
            "status": status,
            "updated": updated,
            "scopes": scopes,
        }
    except FileNotFoundError:
        return {"status": "not_connected", "scopes": []}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "invalid", "scopes": []}
