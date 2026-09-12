"""Collect model measurements without attributing shared resources to one model."""

import asyncio
import json
import math
import time
from pathlib import Path
from typing import Any

import httpx
import psutil

from frigate.config import FrigateConfig, GenAIConfig
from frigate.const import MODEL_CACHE_DIR
from frigate.stats.generation_metrics import read_generation_metrics

AUDIO_TELEMETRY = Path(MODEL_CACHE_DIR) / "audio-trial-telemetry/models.json"


def number(value: Any) -> float | None:
    """Accept only finite, nonnegative measurements."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def disk_size(path: str | None) -> int | None:
    """Read a single configured model's file size without scanning recordings."""
    if not path:
        return None
    try:
        return Path(path).stat().st_size if Path(path).is_file() else None
    except OSError:
        return None


def process_memory(pid: int | None) -> int | None:
    """Get resident bytes for a process, not a claim about model-only memory."""
    try:
        return psutil.Process(pid).memory_info().rss if pid else None
    except (psutil.Error, OSError):
        return None


def audio_models() -> tuple[list[dict], dict]:
    """Read a bounded, sanitized telemetry file; never expose audio transcripts."""
    try:
        if AUDIO_TELEMETRY.stat().st_size > 65536:
            return [], {"status": "invalid"}
        data = json.loads(AUDIO_TELEMETRY.read_text())
        updated = number(data.get("updated"))
        stale = updated is None or not 0 <= time.time() - updated <= 90
        models = []
        for key, name, role in (
            ("medium", "Whisper Medium", "speech_translation"),
            ("large-v3", "Whisper Large-v3", "speech_second_opinion"),
            ("clap", "CLAP", "sound_recognition"),
            ("vad", "Silero VAD", "speech_filter"),
        ):
            entry = data.get("models", {}).get(key, {})
            status = entry.get("status", "unknown")
            if status not in {"cached", "busy", "loading", "loaded", "missing"}:
                status = "unknown"
            row = {
                "id": "audio:" + key,
                "name": name,
                "role": role,
                "location": "audio_worker",
                "device": "CPU",
                "status": "stale" if stale else status,
                "resource_scope": "process",
            }
            for field in (
                "disk_bytes",
                "ram_bytes",
                "peak_ram_bytes",
                "cpu_percent",
                "gpu_memory_bytes",
                "latency_ms",
                "load_ms",
                "last_used",
            ):
                value = number(entry.get(field))
                if stale and field in {"ram_bytes", "cpu_percent", "gpu_memory_bytes"}:
                    value = None
                row[field] = (
                    int(value)
                    if value is not None and field.endswith("bytes")
                    else value
                )
            models.append(row)
        # Return explicit fields only. Telemetry shares a cache directory with
        # benchmark files; none of those files or their text belongs in the API.
        queue = data.get("queue", {})
        reason = data.get("pause_reason", "")
        allowed_reasons = {"", "memory", "detector", "frames", "health", "poll"}
        return models, {
            "status": "stale" if stale else "connected",
            "updated": updated,
            "pending": number(queue.get("pending")),
            "failed": number(queue.get("failed")),
            "completed": number(queue.get("done")),
            "expired": number(queue.get("expired")),
            "oldest_wait_seconds": number(data.get("oldest_wait_seconds")),
            "pause_reason": reason if reason in allowed_reasons else "health",
            "available_bytes": number(data.get("available_bytes")),
        }
    except FileNotFoundError:
        return [], {"status": "not_connected"}
    except (OSError, ValueError, TypeError, AttributeError):
        return [], {"status": "invalid"}


def collect_local_models(config: FrigateConfig, stats: dict) -> tuple[list[dict], dict]:
    """Combine detector and enabled-feature inventory with audio telemetry."""
    models = []
    for name, detector in config.detectors.items():
        measurement = stats.get("detectors", {}).get(name, {})
        model = detector.model or config.model
        path = model.path
        models.append(
            {
                "id": "detector:" + name,
                "name": Path(path).name if path else name,
                "role": "object_detection",
                "location": "frigate",
                "device": f"{detector.type} / {getattr(detector, 'device', 'AUTO')}",
                "status": "loaded" if measurement.get("pid") else "unknown",
                "resource_scope": "process",
                "disk_bytes": disk_size(path),
                "ram_bytes": process_memory(measurement.get("pid")),
                "cpu_percent": number(measurement.get("cpu")),
                "latency_ms": number(measurement.get("inference_speed")),
            }
        )
    # Enrichments share processes; report those resources as shared, not additive.
    process = stats.get("processes", {}).get("embeddings", {})
    for enabled, key, role, feature_name, feature_path in (
        (
            config.semantic_search.enabled,
            "image_embedding_speed",
            "semantic_search",
            getattr(
                config.semantic_search.model, "value", config.semantic_search.model
            ),
            None,
        ),
        (
            config.face_recognition.enabled,
            "face_recognition_speed",
            "face_recognition",
            "Face recognition",
            None,
        ),
        (
            config.lpr.enabled,
            "plate_recognition_speed",
            "license_plate",
            "License plate recognition",
            None,
        ),
        (
            any(c.audio.enabled for c in config.cameras.values()),
            None,
            "sound_detection",
            "YAMNet",
            "/cpu_audio_model.tflite",
        ),
    ):
        if not enabled:
            continue
        shared = (
            stats.get("processes", {}).get("audio_detector", {})
            if role == "sound_detection"
            else process
        )
        models.append(
            {
                "id": "feature:" + role,
                "name": feature_name,
                "role": role,
                "location": "frigate",
                "device": "CPU" if role == "sound_detection" else "configured",
                "status": "enabled",
                "resource_scope": "shared_process",
                "disk_bytes": disk_size(feature_path),
                "ram_bytes": process_memory(shared.get("pid")),
                "cpu_percent": number(shared.get("cpu")),
                "latency_ms": number(stats.get("embeddings", {}).get(key)),
            }
        )
    audio, queue = audio_models()
    return models + audio, queue


async def collect_ollama_models(config: FrigateConfig) -> list[dict]:
    """Query only configured Ollama servers without loading or generating models."""

    async def collect(name: str, provider: GenAIConfig) -> dict:
        row = {
            "id": "genai:" + name,
            "name": provider.model,
            "role": "generative_ai",
            "location": "ollama",
            "device": "unknown",
            "status": "unavailable",
            "resource_scope": "model_allocation",
        }
        row.update(await asyncio.to_thread(read_generation_metrics, provider))
        headers = (
            {"Authorization": "Bearer " + provider.api_key} if provider.api_key else {}
        )
        try:
            async with httpx.AsyncClient(timeout=3, follow_redirects=False) as client:
                responses = await asyncio.gather(
                    *(
                        client.get(
                            (provider.base_url or "http://localhost:11434").rstrip("/")
                            + endpoint,
                            headers=headers,
                        )
                        for endpoint in ("/api/ps", "/api/tags")
                    )
                )
            for response in responses:
                response.raise_for_status()
            loaded, stored = [
                response.json().get("models", []) for response in responses
            ]
            expected = (
                provider.model if ":" in provider.model else provider.model + ":latest"
            )

            def match(item: dict) -> bool:
                return item.get("name", item.get("model")) in {provider.model, expected}

            cached = next((m for m in stored if match(m)), None)
            resident = next((m for m in loaded if match(m)), None)
            row["status"] = "loaded" if resident else "cached" if cached else "missing"
            row["disk_bytes"] = cached.get("size") if cached else None
            if resident:
                row["gpu_memory_bytes"] = resident.get("size_vram")
                row["context_length"] = resident.get("context_length")
                row["device"] = "GPU" if resident.get("size_vram", 0) > 0 else "CPU"
                # /api/ps size is an allocation estimate, not process RSS.
                # Do not subtract VRAM from it and label the remainder as RAM.
            return row
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            return row

    return list(
        await asyncio.gather(
            *(
                collect(name, provider)
                for name, provider in config.genai.items()
                if provider.provider == "ollama"
            )
        )
    )
