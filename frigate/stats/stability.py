"""Read bounded administrator-only stability evidence without private logs."""

import json
import time
from pathlib import Path

from frigate.const import MODEL_CACHE_DIR
from frigate.stats.ai_models import number

PATH = Path(MODEL_CACHE_DIR) / "stability.json"
KINDS = {
    "ai",
    "detection",
    "capture",
    "recording",
    "recording_unknown",
    "server",
    "restart",
    "memory",
    "audio",
    "monitoring",
}


def read_stability() -> dict:
    """Expose incident codes and numeric graph values from a local collector."""
    try:
        if PATH.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Oversized stability snapshot")
        data = json.loads(PATH.read_text())
        updated = number(data.get("updated"))
        fresh = updated is not None and 0 <= time.time() - updated <= 60
        incidents = []
        for entry in data.get("incidents", [])[:100]:
            kind, _, scope = str(entry.get("key", "")).partition(":")
            if kind not in KINDS:
                continue
            incidents.append(
                {
                    "kind": kind,
                    "scope": scope[:64],
                    **{
                        key: number(entry.get(key))
                        for key in ("started", "updated", "resolved")
                    },
                }
            )
        samples = []
        for row in data.get("samples", [])[:120]:
            latencies = [
                v
                for v in map(number, row.get("detector_ms", {}).values())
                if v is not None
            ]
            skips = [
                number(v.get("skipped_fps")) for v in row.get("cameras", {}).values()
            ]
            skips = [v for v in skips if v is not None]
            samples.append(
                {
                    "time": number(row.get("time")),
                    "detector_ms": max(latencies, default=None),
                    "skipped_fps": sum(v for v in skips if v is not None)
                    if skips
                    else None,
                    "ollama_requests": len(row["ollama_completions_last_20s"])
                    if isinstance(row.get("ollama_completions_last_20s"), list)
                    else None,
                }
            )
        latest = data.get("samples", [])[-1] if data.get("samples") else {}
        failure = latest.get("audio_failure", {})
        safe_failure = sanitize_failure(failure)
        return {
            "audio_failure": safe_failure,
            "status": "connected" if fresh else "stale",
            "updated": updated,
            "incidents": incidents,
            "samples": samples,
        }
    except FileNotFoundError:
        return {"status": "not_connected", "incidents": [], "samples": []}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "invalid", "incidents": [], "samples": []}


def sanitize_failure(failure: dict) -> dict:
    """Expose only fixed failure vocabulary, never arbitrary model errors."""
    return {
        "updated": number(failure.get("updated")),
        "stage": failure.get("stage")
        if failure.get("stage")
        in {
            "download",
            "conversion",
            "medium",
            "large-v3",
            "worker",
            "transcription",
            "translation",
            "sounds",
        }
        else "unknown",
        "cause": failure.get("cause")
        if failure.get("cause")
        in {
            "timeout",
            "http_error",
            "camera_priority",
            "shutdown",
            "download_limit",
            "memory_reserve",
            "process_exit",
            "unavailable",
        }
        else "unknown",
    }
