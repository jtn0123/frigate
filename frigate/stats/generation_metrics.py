"""Record timing metadata for scene descriptions without storing their contents."""

import hashlib
import json
import math
import os
import tempfile
import time
from pathlib import Path

from frigate.const import MODEL_CACHE_DIR

METRICS_DIRECTORY = Path(MODEL_CACHE_DIR) / "generation-metrics"


def metrics_path(provider) -> Path:
    """Identify a configured endpoint and model without exposing its URL."""
    key = json.dumps([provider.base_url or "http://localhost:11434", provider.model])
    return METRICS_DIRECTORY / (hashlib.sha256(key.encode()).hexdigest() + ".json")


def finite(value) -> float | None:
    """Reject missing, nonnumeric, negative, and nonfinite provider metadata."""
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


def record_generation_metrics(provider, response, elapsed: float) -> None:
    """Best-effort atomic timing write; failures never interrupt descriptions."""
    total = finite(response.get("total_duration"))
    load = finite(response.get("load_duration"))
    data = {
        "last_used": time.time(),
        "latency_ms": total / 1e6 if total is not None else elapsed * 1000,
        "load_ms": load / 1e6 if load is not None else None,
    }
    temporary = None
    try:
        METRICS_DIRECTORY.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", dir=METRICS_DIRECTORY, delete=False
        ) as file:
            temporary = Path(file.name)
            json.dump(data, file)
        os.replace(temporary, metrics_path(provider))
    except OSError:
        # Optional telemetry must never fail a successfully generated description.
        pass
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def read_generation_metrics(provider) -> dict:
    """Read only timing fields; these are historical values, not live usage."""
    try:
        path = metrics_path(provider)
        if path.stat().st_size > 4096:
            return {}
        data = json.loads(path.read_text())
        return {
            key: finite(data.get(key)) for key in ("last_used", "latency_ms", "load_ms")
        }
    except (OSError, ValueError, AttributeError):
        return {}
