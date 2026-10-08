"""Bounded verification of saved recording packets without decoding video."""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import statistics
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

PROBE_TIMEOUT = 5
PROBE_MAX_BYTES = 4 * 1024 * 1024
PROBE_MAX_PACKETS = 32768
MAX_VIDEO_SECONDS = 600
INTEGRITY_REASONS = frozenset(
    {
        "ok",
        "duration_mismatch",
        "video_timing",
        "audio_timing",
        "audio_missing",
        "probe_failed",
        "probe_timeout",
        "probe_limit",
    }
)
AUDIO_STATUSES = frozenset({"ok", "not_present", "invalid", "missing", "unknown"})


@dataclass(frozen=True)
class RecordingIntegrity:
    """Verified video availability and independent audio health."""

    reason: str
    video_seconds: float | None = None
    audio_status: str = "unknown"
    keyframes: tuple[int, ...] = ()
    audio_present: bool | None = None
    video_start: float = 0.0
    # Nonzero offsets remain unverified until a normalized copy passes the probe.
    video_seek_offset: float = 0.0

    @property
    def video_verified(self) -> bool:
        """Audio warnings do not remove available, verified video."""
        return self.reason in {"ok", "audio_timing", "audio_missing"}


def finite_number(value: Any) -> float | None:
    """Accept finite numeric probe values without treating booleans as times."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _packets(data: dict[str, Any], index: int) -> list[dict[str, Any]]:
    return [packet for packet in data["packets"] if packet.get("stream_index") == index]


def _packet_intervals(
    packets: list[dict[str, Any]],
) -> list[tuple[float, float]] | None:
    intervals = []
    previous_dts = -math.inf
    for packet in packets:
        pts = finite_number(packet.get("pts_time"))
        dts = finite_number(packet.get("dts_time"))
        duration = finite_number(packet.get("duration_time"))
        if pts is None or dts is None or duration is None:
            return None
        if not 0 < duration < MAX_VIDEO_SECONDS or dts < previous_dts - 0.000001:
            return None
        intervals.append((pts, pts + duration))
        previous_dts = dts
    return sorted(intervals)


def _video_span(intervals: list[tuple[float, float]] | None) -> float | None:
    if not intervals:
        return None
    start = intervals[0][0]
    end = max(right for _, right in intervals)
    duration = end - start
    # Positive MP4 offsets represent a leading period without video. Preserve
    # that offset for DB registration instead of claiming it as video coverage.
    if not -0.000001 <= start <= 1 or not 0 < duration < MAX_VIDEO_SECONDS:
        return None
    tolerance = max(0.25, 2 * statistics.median(b - a for a, b in intervals))
    cursor = intervals[0][1]
    for left, right in intervals[1:]:
        if left - cursor > tolerance:
            return None
        cursor = max(cursor, right)
    return duration


def _covered_audio_seconds(
    intervals: list[tuple[float, float]], start: float, end: float
) -> tuple[float, float]:
    """Measure packet union and longest missing interval inside the video."""
    covered = 0.0
    longest_gap = 0.0
    cursor = start
    for left, right in intervals:
        left, right = max(start, left), min(end, right)
        if right <= max(cursor, left):
            continue
        longest_gap = max(longest_gap, left - cursor)
        covered += right - max(cursor, left)
        cursor = right
    return covered, max(longest_gap, end - cursor)


def _audio_status(
    streams: list[dict[str, Any]],
    data: dict[str, Any],
    video_start: float,
    video_seconds: float,
    expected_audio: bool | None,
) -> tuple[str, str, bool]:
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if not audio:
        return (
            ("audio_missing", "missing", False)
            if expected_audio
            else ("ok", "not_present", False)
        )
    intervals = _packet_intervals(_packets(data, audio[0]["index"]))
    if intervals is None:
        return "audio_timing", "invalid", True
    if not intervals:
        return "audio_missing", "missing", True
    left = intervals[0][0]
    right = max(end for _, end in intervals)
    if left < video_start - 1 or right > video_start + video_seconds + 1:
        return "audio_timing", "invalid", True
    covered, gap = _covered_audio_seconds(
        intervals, video_start, video_start + video_seconds
    )
    tolerance = max(0.25, 2 * statistics.median(b - a for a, b in intervals))
    if covered < video_seconds * 0.9 or gap > tolerance:
        return "audio_missing", "missing", True
    return "ok", "ok", True


def _probe_shape_error(data: Any) -> str | None:
    """Reject malformed or oversized probe structures before packet processing."""
    if not isinstance(data, dict):
        return "probe_failed"
    streams, packets = data.get("streams"), data.get("packets")
    if not isinstance(streams, list) or not isinstance(packets, list):
        return "probe_failed"
    if len(streams) > 8 or len(packets) > PROBE_MAX_PACKETS:
        return "probe_limit"
    if any(not isinstance(row, dict) for row in streams + packets):
        return "probe_failed"
    if any(type(stream.get("index")) is not int for stream in streams):
        return "probe_failed"
    return None


def _video_seek_offset(data: dict[str, Any], video_start: float) -> float | None:
    """Measure the leading audio interval that relative seeks must skip."""
    container = data.get("format")
    if not isinstance(container, dict):
        return None
    file_start = finite_number(container.get("start_time"))
    if file_start is None or file_start < -0.000001:
        return None
    offset = video_start - file_start
    if abs(offset) <= 0.000001:
        return 0.0
    return offset if 0 < offset <= 1 else None


def inspect_recording(
    data: Any, source_seconds: float, expected_audio: bool | None = None
) -> RecordingIntegrity:
    """Validate the final MP4 and reject an uncertain cache-to-video mapping."""
    if error := _probe_shape_error(data):
        return RecordingIntegrity(error)
    streams = data["streams"]
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(video) != 1:
        return RecordingIntegrity("video_timing")
    video_packets = _packets(data, video[0]["index"])
    intervals = _packet_intervals(video_packets)
    duration = _video_span(intervals)
    if duration is None or intervals is None:
        return RecordingIntegrity("video_timing")
    seek_offset = _video_seek_offset(data, intervals[0][0])
    if seek_offset is None:
        return RecordingIntegrity("video_timing")
    source = finite_number(source_seconds)
    if (
        source is None
        or not 0 < source < MAX_VIDEO_SECONDS
        or abs(source - (intervals[0][0] + duration)) > max(0.25, duration * 0.05)
    ):
        return RecordingIntegrity("duration_mismatch", duration)
    keyframes = tuple(
        sorted(
            {
                max(0, round((float(packet["pts_time"]) - intervals[0][0]) * 1000))
                for packet in video_packets
                if "K" in str(packet.get("flags", ""))
            }
        )
    )
    reason, audio_status, audio_present = _audio_status(
        streams, data, intervals[0][0], duration, expected_audio
    )
    return RecordingIntegrity(
        "video_timing" if seek_offset else reason,
        duration,
        audio_status,
        keyframes,
        audio_present,
        max(0.0, intervals[0][0]),
        seek_offset,
    )


class ProbeLimitError(ValueError):
    """The probe emitted more than the bounded metadata budget."""


async def _read_probe(process: asyncio.subprocess.Process) -> bytes:
    if process.stdout is None:
        raise ValueError("Probe output pipe is unavailable")
    output = bytearray()
    while chunk := await process.stdout.read(65536):
        output.extend(chunk)
        if len(output) > PROBE_MAX_BYTES:
            raise ProbeLimitError
    await process.wait()
    return bytes(output)


async def _normalize_video_origin(
    ffmpeg: str,
    ffprobe: str,
    path: str,
    source_seconds: float,
    original: RecordingIntegrity,
    expected_audio: bool | None,
) -> RecordingIntegrity:
    """Align file-relative seeks without discarding video or re-encoding media."""
    normalized_path = f"{path}.normalized.tmp"
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-ss",
            str(original.video_seek_offset),
            "-i",
            path,
            "-c",
            "copy",
            "-map_metadata",
            "0",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            normalized_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(process.wait(), 10)
        if process.returncode != 0:
            return RecordingIntegrity("probe_failed")
        normalized = await probe_recording_integrity(
            ffprobe,
            normalized_path,
            source_seconds - original.video_start,
            expected_audio,
        )
        # Seeking while copying must retain the full video, including its first
        # keyframe. Reject a remux that drops/reorders coverage or keeps an offset.
        if (
            not normalized.video_verified
            or normalized.video_start > 0.000001
            or normalized.video_seconds is None
            or original.video_seconds is None
            or abs(normalized.video_seconds - original.video_seconds) > 0.000001
            or normalized.keyframes != original.keyframes
        ):
            return original
        await asyncio.to_thread(os.replace, normalized_path, path)
        # Registration still starts at the original video's wall-clock offset;
        # only the saved file's playback origin has moved to zero.
        return replace(normalized, video_start=original.video_start)
    finally:
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), 2)
        await asyncio.to_thread(Path(normalized_path).unlink, missing_ok=True)


async def probe_recording_integrity(
    ffprobe: str,
    path: str,
    source_seconds: float,
    expected_audio: bool | None = None,
    *,
    ffmpeg: str | None = None,
) -> RecordingIntegrity:
    """Verify final media, optionally normalizing its seek origin with stream copy."""
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            ffprobe,
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-max_alloc",
            "16777216",
            "-probesize",
            "1048576",
            "-analyzeduration",
            "2000000",
            "-show_entries",
            "format=start_time:stream=index,codec_type:packet=stream_index,pts_time,dts_time,duration_time,flags",
            "-show_packets",
            "-of",
            "json",
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        output = await asyncio.wait_for(_read_probe(process), PROBE_TIMEOUT)
        if process.returncode != 0:
            return RecordingIntegrity("probe_failed")
        result = inspect_recording(json.loads(output), source_seconds, expected_audio)
        if ffmpeg is not None and result.video_seek_offset > 0:
            return await _normalize_video_origin(
                ffmpeg, ffprobe, path, source_seconds, result, expected_audio
            )
        return result
    except ProbeLimitError:
        return RecordingIntegrity("probe_limit")
    except TimeoutError:
        return RecordingIntegrity("probe_timeout")
    except (OSError, ValueError, TypeError):
        return RecordingIntegrity("probe_failed")
    finally:
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.communicate(), 2)
