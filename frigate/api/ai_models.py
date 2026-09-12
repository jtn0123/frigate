"""Admin-only model inventory and resource measurements."""

import asyncio
import logging
import sqlite3
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from frigate.api.auth import require_role
from frigate.stats.ai_models import (
    collect_local_models,
    collect_ollama_models,
    number,
    stats_fresh,
)
from frigate.stats.model_history import read_history, save_sample
from frigate.stats.server_pressure import read_server_pressure

logger = logging.getLogger(__name__)

router = APIRouter(tags=["App"])


class AIModelStatus(BaseModel):
    """Model metrics with explicit attribution and unknown values."""

    id: str
    name: str
    role: str
    location: str
    device: str
    status: str
    resource_scope: str = "unavailable"
    disk_bytes: int | None = None
    ram_bytes: int | None = None
    peak_ram_bytes: int | None = None
    cpu_percent: float | None = None
    gpu_memory_bytes: int | None = None
    latency_ms: float | None = None
    load_ms: float | None = None
    last_used: float | None = None
    context_length: int | None = None


class AIModelsResponse(BaseModel):
    """Model inventory plus shared device and queue context."""

    updated: float
    models: list[AIModelStatus]
    audio: dict
    shared_gpus: dict
    source_updated: float | None = None
    telemetry_status: str = "unknown"
    server: dict = {}
    history_status: str = "unavailable"


@router.get(
    "/ai/models",
    dependencies=[Depends(require_role(["admin"]))],
)
async def ai_models(request: Request) -> AIModelsResponse:
    """Return cached local measurements and bounded read-only provider queries."""
    return await sample_models(request.app)


async def sample_models(app) -> AIModelsResponse:
    """Collect sanitized model metrics using one lock per application."""
    # Cache belongs to this app instance, never another server or test instance.
    lock = getattr(app.state, "ai_models_lock", None)
    if lock is None:
        lock = app.state.ai_models_lock = asyncio.Lock()
    async with lock:
        cached = getattr(app.state, "ai_models_cache", None)
        if cached and time.monotonic() - cached[0] < 10:
            return cached[1]
        config = app.frigate_config
        stats = await asyncio.to_thread(app.stats_emitter.get_latest_stats)
        local, remote = await asyncio.gather(
            asyncio.to_thread(collect_local_models, config, stats),
            collect_ollama_models(config),
        )
        models, audio = local
        response = AIModelsResponse(
            updated=time.time(),
            models=models + remote,
            audio=audio,
            source_updated=number(stats.get("service", {}).get("last_updated")),
            telemetry_status="connected" if stats_fresh(stats) else "stale",
            server=await asyncio.to_thread(read_server_pressure),
            shared_gpus={
                name: {k: value.get(k) for k in ("gpu", "mem", "temp", "vendor")}
                for name, value in (
                    stats.get("gpu_usages", {}) if stats_fresh(stats) else {}
                ).items()
            },
        )
        response.history_status = "connected"
        try:
            await asyncio.to_thread(save_sample, response.model_dump())
        except (OSError, sqlite3.Error, ValueError):
            response.history_status = "unavailable"
            logger.warning("AI model history unavailable")
        else:
            response.history_status = "connected"
        app.state.ai_models_cache = (time.monotonic(), response)
        return response


@router.get("/ai/models/history", dependencies=[Depends(require_role(["admin"]))])
async def ai_models_history() -> dict:
    """Return one day of minute samples, never event transcripts."""
    try:
        samples = await asyncio.to_thread(read_history)
    except (OSError, sqlite3.Error, ValueError):
        return {"status": "unavailable", "samples": []}
    return {"status": "connected", "samples": samples}


async def model_sampler(app) -> None:
    """Continue collection with no browser connected; cancellation stops cleanly."""
    while True:
        try:
            await sample_models(app)
        except Exception:
            # A monitoring failure must not terminate the NVR API or sampler.
            logger.exception("AI model sample unavailable")
        await asyncio.sleep(10)
