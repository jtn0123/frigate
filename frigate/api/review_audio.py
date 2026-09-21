"""Camera-scoped access to unverified companion analysis, separate from descriptions."""

import asyncio
import hashlib
import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from peewee import DoesNotExist

from frigate.api.auth import allow_any_authenticated, require_camera_access
from frigate.api.defs.response.fork_audio import AudioChunk, AudioResultsResponse
from frigate.api.defs.response.generic_response import GenericResponse
from frigate.const import MODEL_CACHE_DIR
from frigate.models import ReviewSegment

router = APIRouter(tags=["Review"])
RESULTS = Path(MODEL_CACHE_DIR) / "audio-trial-telemetry/results"


def read_results(review_id: str, camera: str) -> dict[str, Any]:
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
        return AudioResultsResponse.model_validate(
            {
                "status": "available",
                "updated": data.get("updated"),
                "chunks": [
                    AudioChunk.model_validate(chunk).model_dump() for chunk in chunks
                ],
            }
        ).model_dump(exclude_unset=True)
    except FileNotFoundError:
        return {"status": "not_available", "chunks": []}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "unavailable", "chunks": []}


@router.get(
    "/review/{review_id}/audio",
    dependencies=[Depends(allow_any_authenticated())],
    response_model=AudioResultsResponse,
    response_model_exclude_unset=True,
    responses={404: {"model": GenericResponse}},
)
async def review_audio(
    request: Request, review_id: str
) -> dict[str, Any] | JSONResponse:
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
