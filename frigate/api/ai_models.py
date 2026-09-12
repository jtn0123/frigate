"""Admin-only model inventory and resource measurements."""

import asyncio
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from frigate.api.auth import require_role
from frigate.stats.ai_models import collect_local_models, collect_ollama_models

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


@router.get(
    "/ai/models",
    response_model=AIModelsResponse,
    dependencies=[Depends(require_role(["admin"]))],
)
async def ai_models(request: Request) -> AIModelsResponse:
    """Return cached local measurements and bounded read-only provider queries."""
    # Cache belongs to this app instance, never another server or test instance.
    lock = getattr(request.app.state, "ai_models_lock", None)
    if lock is None:
        lock = request.app.state.ai_models_lock = asyncio.Lock()
    async with lock:
        cached = getattr(request.app.state, "ai_models_cache", None)
        if cached and time.monotonic() - cached[0] < 10:
            return cached[1]
        config = request.app.frigate_config
        stats = await asyncio.to_thread(request.app.stats_emitter.get_latest_stats)
        local, remote = await asyncio.gather(
            asyncio.to_thread(collect_local_models, config, stats),
            collect_ollama_models(config),
        )
        models, audio = local
        response = AIModelsResponse(
            updated=time.time(),
            models=models + remote,
            audio=audio,
            shared_gpus={
                name: {k: value.get(k) for k in ("gpu", "mem", "temp", "vendor")}
                for name, value in stats.get("gpu_usages", {}).items()
            },
        )
        request.app.state.ai_models_cache = (time.monotonic(), response)
        return response
