"""Camera-scoped access to unverified companion analysis, separate from descriptions."""

import asyncio
import hashlib
import json
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from peewee import DoesNotExist
from pydantic import BaseModel, ConfigDict, Field

from frigate.api.auth import allow_any_authenticated, require_camera_access
from frigate.const import MODEL_CACHE_DIR
from frigate.models import ReviewSegment

router = APIRouter(tags=["Review"])
RESULTS = Path(MODEL_CACHE_DIR) / "audio-trial-telemetry/results"


class SoundResult(BaseModel):
    """A raw suggestion, not a probability."""

    model_config = ConfigDict(allow_inf_nan=False)
    label: str = Field(max_length=200)
    similarity: float


class StageResult(BaseModel):
    """Expose state without internal error details."""

    status: str = Field(max_length=40)


class AudioAnalysis(BaseModel):
    """Bound user-visible machine output and omit private worker fields."""

    transcript: str = Field(default="", max_length=20000)
    translation: str = Field(default="", max_length=20000)
    language: str | None = Field(default=None, max_length=20)
    sounds: list[SoundResult] = Field(default_factory=list, max_length=10)
    stages: dict[str, StageResult] = Field(default_factory=dict, max_length=10)
    large_status: str | None = Field(default=None, max_length=200)
    large_second_opinion: "AudioAnalysis | None" = None


class AudioChunk(BaseModel):
    """One bounded interval associated with this authorized review."""

    model_config = ConfigDict(allow_inf_nan=False)
    id: str = Field(max_length=200)
    start: float
    end: float
    state: str = Field(max_length=40)
    result: AudioAnalysis | None = None


def read_results(review_id: str, camera: str) -> dict:
    """Read only the exact review/camera pair from a bounded hashed file."""
    path = RESULTS / (hashlib.sha256(review_id.encode()).hexdigest() + ".json")
    try:
        info = path.stat()
        if time.time() - info.st_mtime > 7 * 86400:
            return {"status": "not_available", "chunks": []}
        if info.st_size > 1024 * 1024:
            return {"status": "unavailable", "chunks": []}
        data = json.loads(path.read_text())
        if data.get("review_id") != review_id or data.get("camera") != camera:
            return {"status": "unavailable", "chunks": []}
        chunks = data.get("chunks")
        if not isinstance(chunks, list) or len(chunks) > 100:
            return {"status": "unavailable", "chunks": []}
        return {
            "status": "available",
            "updated": data.get("updated"),
            "chunks": [
                AudioChunk.model_validate(chunk).model_dump() for chunk in chunks
            ],
        }
    except FileNotFoundError:
        return {"status": "not_available", "chunks": []}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "unavailable", "chunks": []}


@router.get(
    "/review/{review_id}/audio", dependencies=[Depends(allow_any_authenticated())]
)
async def review_audio(request: Request, review_id: str):
    """Authorize the review before opening its stored machine-generated results."""
    try:
        review = await asyncio.to_thread(
            ReviewSegment.get, ReviewSegment.id == review_id
        )
    except DoesNotExist:
        return JSONResponse(
            status_code=404,
            content={"success": False, "message": "Review item not found"},
        )
    await require_camera_access(review.camera, request=request)
    return await asyncio.to_thread(read_results, review_id, review.camera)
