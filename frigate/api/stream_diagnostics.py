"""Bounded, camera-authorized diagnostics for live playback failures."""

import asyncio
import logging
import re
import time
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from frigate.api.auth import require_go2rtc_stream_access
from frigate.util.config import resolve_ffmpeg_path

logger = logging.getLogger(__name__)
router = APIRouter()
_probe_slots = asyncio.Semaphore(2)
_cache: dict[str, tuple[float, dict]] = {}
_inflight: dict[str, asyncio.Task] = {}


class PlaybackFailure(BaseModel):
    """Structured client playback failure."""

    reason: Literal["startup", "stalled", "mse-decode", "manual"] = "manual"
    media_error_code: int | None = Field(default=None, ge=0, le=4)


def summarize_decode(returncode: int, stderr: str, frames: int) -> str:
    """Treat decoder errors as failures even when FFmpeg exits successfully."""
    if re.search(
        r"cu_qp_delta|CABAC|decod|Invalid NAL|Could not find ref|frame RPS",
        stderr,
        re.IGNORECASE,
    ):
        return "decode_error"
    if returncode != 0 or frames == 0:
        return "stream_unavailable"
    return "healthy" if not stderr.strip() else "decode_error"


def safe_decoder_detail(stderr: str) -> str:
    """Strip credentials and query strings from bounded decoder diagnostics."""
    text = re.sub(r"(\w+://)[^\s/@]+@", r"\1<redacted>@", stderr)
    text = re.sub(r"(\w+://[^\s?]+)\?[^\s]*", r"\1?<redacted>", text)
    return "\n".join(text.splitlines()[:6])[:1600]


async def decode_stream(binary: str, stream_name: str) -> dict:
    """Decode a short restream sample, killing timed-out or cancelled probes."""
    process = await asyncio.create_subprocess_exec(
        binary,
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-threads",
        "2",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "5000000",
        "-i",
        f"rtsp://127.0.0.1:8554/{quote(stream_name, safe='')}",
        "-t",
        "2",
        "-an",
        "-fps_mode",
        "vfr",
        "-progress",
        "pipe:1",
        "-f",
        "null",
        "-",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr_bytes = await asyncio.wait_for(process.communicate(), 12)
    except (TimeoutError, asyncio.CancelledError) as error:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        if isinstance(error, asyncio.CancelledError):
            raise
        return {"status": "timeout", "decoded_frames": 0, "decoder_errors": 0}
    stderr = stderr_bytes.decode(errors="replace")
    counts = re.findall(rb"^frame=(\d+)$", stdout, re.MULTILINE)
    frames = int(counts[-1]) if counts else 0
    return {
        "status": summarize_decode(process.returncode, stderr, frames),
        "decoded_frames": frames,
        "decoder_errors": len(stderr.splitlines()),
        "decoder_detail": safe_decoder_detail(stderr),
    }


async def collect_diagnostics(binary: str, stream_name: str) -> dict:
    """Collect stream metadata and decode evidence without exposing source URLs."""
    started = time.monotonic()
    result = {"id": uuid4().hex[:12], "stream": stream_name, "codecs": []}
    async with _probe_slots:
        try:
            async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
                response = await client.get("http://127.0.0.1:1984/api/streams")
                response.raise_for_status()
                metadata = response.json().get(stream_name, {})
            producers = metadata.get("producers") or []
            result["producer_count"] = len(producers)
            result["received_bytes"] = sum(
                p.get("bytes_recv", p.get("recv", 0)) or 0 for p in producers
            )
            result["codecs"] = sorted(
                {
                    codec
                    for p in producers
                    for media in p.get("medias", [])
                    for codec in ["H265", "H264", "AAC", "MPEG4-GENERIC"]
                    if codec in media
                }
            )
            result.update(await decode_stream(binary, stream_name))
        except (httpx.HTTPError, ValueError, OSError):
            result["status"] = "unavailable"
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    logger.log(
        logging.INFO if result["status"] == "healthy" else logging.WARNING,
        "Live stream diagnostic id=%s stream=%r status=%s codecs=%s frames=%s errors=%s elapsed_ms=%s detail=%s",
        result["id"],
        stream_name,
        result["status"],
        result["codecs"],
        result.get("decoded_frames", 0),
        result.get("decoder_errors", 0),
        result["elapsed_ms"],
        result.get("decoder_detail", "").replace("\n", " | "),
    )
    return result


@router.post(
    "/go2rtc/streams/{stream_name}/diagnostics",
    dependencies=[Depends(require_go2rtc_stream_access)],
    operation_id="diagnose_live_stream",
)
async def stream_diagnostics(request: Request, stream_name: str, body: PlaybackFailure):
    """Check a permitted live stream and correlate its result with a player failure."""
    streams = request.app.frigate_config.go2rtc.model_dump().get("streams", {})
    if stream_name not in streams:
        raise HTTPException(status_code=404, detail="Stream not configured")
    now = time.monotonic()
    for name, (created, _) in list(_cache.items()):
        if now - created >= 30:
            del _cache[name]
    cached = _cache.get(stream_name)
    if cached:
        result = cached[1]
    else:
        task = _inflight.get(stream_name)
        if task is None:
            if len(_inflight) >= 2:
                raise HTTPException(status_code=429, detail="Stream diagnostics busy")
            binary = resolve_ffmpeg_path(request.app.frigate_config.ffmpeg.path)
            task = asyncio.create_task(collect_diagnostics(binary, stream_name))
            _inflight[stream_name] = task

            def completed(probe: asyncio.Task) -> None:
                _inflight.pop(stream_name, None)
                if not probe.cancelled() and probe.exception() is None:
                    _cache[stream_name] = (time.monotonic(), probe.result())

            task.add_done_callback(completed)
        result = await asyncio.shield(task)
    logger.info(
        "Live player failure diagnostic_id=%s stream=%r reason=%s media_error_code=%s",
        result["id"],
        stream_name,
        body.reason,
        body.media_error_code,
    )
    return result
