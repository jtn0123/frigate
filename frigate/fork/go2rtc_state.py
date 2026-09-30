"""Fork (I57): what go2rtc knows about each camera's source, made safe to show.

go2rtc keeps one entry per configured stream in `/api/streams`. Every source
of a stream is listed as a producer from startup, and a producer that is not
connected carries nothing but its `url`. Once go2rtc has dialed the source the
producer gains `medias` (the tracks the camera offered) and a byte counter
(`bytes_recv`, or `recv` on older builds). That difference is the whole signal
here: a camera whose source keeps timing out never gets past the bare `url`.

go2rtc connects lazily, only while something reads the stream, and it drops
the reader when the dial fails. A stream that nobody is reading therefore
looks the same as one whose source is unreachable, so the consumer count is
returned next to the state and the UI says so.

Source URLs hold camera credentials, in the userinfo, in query parameters
(`user=`, `password=`, `token=`), and inside `exec:` command lines. Nothing in
this module returns one: `safe_source` reduces a source to its scheme and
host, and everything else is dropped.
"""

import logging
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from typing import Any
from urllib.parse import unquote

import requests
from requests.exceptions import RequestException

logger = logging.getLogger(__name__)

# Same endpoint frigate/api/camera.py and stream_diagnostics.py read.
GO2RTC_STREAMS_URL = "http://127.0.0.1:1984/api/streams"
FETCH_TIMEOUT_SECONDS = 2
# Many browser tabs poll this; go2rtc is asked at most this often.
CACHE_SECONDS = 5.0

UNKNOWN_SOURCE = "unknown"
MAX_CODECS = 6

_SCHEME = re.compile(r"([A-Za-z][A-Za-z0-9+.-]{0,15}):(.*)", re.DOTALL)
_HOST = re.compile(
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])"
    r"(?::(\d{1,5}))?"
)
_AUTHORITY_END = re.compile(r"[/?#]")
# Sources whose remainder is a command line or script: nothing in it is safe.
_OPAQUE_SCHEMES = frozenset({"exec", "echo", "expr"})
# go2rtc modules written as a prefix in front of another source.
_PREFIX_SCHEMES = frozenset({"ffmpeg", "webrtc", "hass", "nest", "ring", "tuya"})
_RESTREAM_PATH = re.compile(
    r"rtsps?://(?:127\.0\.0\.1|localhost|\[::1\]):8554/([^/?#]+)", re.IGNORECASE
)
_CODEC = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,23}")

StreamState = dict[str, Any]


def _safe_host(after_slashes: str) -> str | None:
    """Return `host[:port]` from the text after `scheme://`, or None.

    The authority ends at the first `/`, `?` or `#`, as it does for go2rtc. An
    `@` after that point means a password with an unescaped delimiter, where
    the text before it is part of the credentials, so nothing is returned.
    """
    end = _AUTHORITY_END.search(after_slashes)
    authority = after_slashes[: end.start()] if end else after_slashes
    tail = after_slashes[end.start() :] if end else ""
    if "@" in tail:
        return None

    host = authority.rpartition("@")[2]
    match = _HOST.fullmatch(host)
    if match is None:
        return None

    port = match.group(1)
    if port is not None and not 1 <= int(port) <= 65535:
        return None

    return host.lower()


def safe_source(raw: object, _depth: int = 0) -> str:
    """Reduce a go2rtc source to a description that is safe to display.

    Only the scheme and the host (with its port) survive, for example
    `rtsp://10.0.0.5:554` or `ffmpeg:http://10.0.0.5`. Userinfo, the path, the
    query string and the fragment are always dropped, because credentials and
    tokens live in all of them.

    Args:
        raw: The source as go2rtc or the config spells it.

    Returns:
        `scheme://host[:port]`, optionally behind a module prefix such as
        `ffmpeg:`; just the scheme when no host can be trusted (`exec`,
        `ffmpeg`, `rtsp`); or `unknown` when there is no recognizable scheme.
    """
    if not isinstance(raw, str):
        return UNKNOWN_SOURCE

    match = _SCHEME.fullmatch(raw.strip())
    if match is None:
        return UNKNOWN_SOURCE

    scheme = match.group(1).lower()
    rest = match.group(2)

    if scheme in _OPAQUE_SCHEMES:
        return scheme

    if rest.startswith("//"):
        host = _safe_host(rest[2:])
        return f"{scheme}://{host}" if host else scheme

    # `name:value` without `//` is only a scheme when go2rtc defines it as a
    # prefix. Anything else could be `user:password@host`.
    if scheme not in _PREFIX_SCHEMES:
        return UNKNOWN_SOURCE

    if _depth >= 1:
        return scheme

    inner = safe_source(rest, _depth + 1)
    return f"{scheme}:{inner}" if "://" in inner else scheme


def restream_name(path: str) -> str | None:
    """Return the go2rtc stream an ffmpeg input reads, if it reads the restream.

    Args:
        path: An ffmpeg input path from the camera config.

    Returns:
        The stream name for `rtsp://127.0.0.1:8554/<name>`, otherwise None.
    """
    match = _RESTREAM_PATH.match(path.strip())
    return unquote(match.group(1)) if match else None


def configured_sources(config: Any) -> dict[str, list[str]]:
    """Return the raw sources per go2rtc stream from the Frigate config.

    The values still hold credentials and must go through `safe_source`.
    """
    streams = config.go2rtc.model_dump().get("streams") or {}
    if not isinstance(streams, Mapping):
        return {}

    sources: dict[str, list[str]] = {}
    for name, value in streams.items():
        values = value if isinstance(value, list) else [value]
        sources[str(name)] = [item for item in values if isinstance(item, str)]
    return sources


def camera_stream_names(config: Any) -> dict[str, list[str]]:
    """Map every camera to the go2rtc streams it depends on.

    A stream belongs to a camera when the camera's `live.streams` names it
    (Frigate fills that with the camera's own name when it is left empty),
    when one of its ffmpeg inputs reads it from the restream, or when it has
    the camera's name. The first and last rules are the ones
    `_get_stream_owner_cameras` in frigate/api/auth.py uses for access checks;
    the ffmpeg rule adds the stream detect and record actually pull from.

    Args:
        config: The Frigate config.

    Returns:
        Stream names per camera, in a stable order and without duplicates.
    """
    known = configured_sources(config)
    mapping: dict[str, list[str]] = {}

    for camera_name, camera in config.cameras.items():
        names: list[str] = []
        candidates: list[str | None] = [
            *(camera.live.streams or {}).values(),
            *(restream_name(item.path) for item in camera.ffmpeg.inputs),
            camera_name if camera_name in known else None,
        ]
        for candidate in candidates:
            if candidate and candidate not in names:
                names.append(candidate)
        mapping[camera_name] = names

    return mapping


def _count(value: object) -> int:
    """Return a byte counter as a non-negative int, 0 for anything else."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


def _items(value: object) -> list[dict[str, Any]]:
    """Return the dict entries of a producers or consumers list."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _producer_bytes(producer: Mapping[str, Any]) -> int:
    return _count(producer.get("bytes_recv", producer.get("recv", 0)))


def _producer_connected(producer: Mapping[str, Any]) -> bool:
    """A producer is connected once it has tracks or has received bytes."""
    return bool(producer.get("medias")) or _producer_bytes(producer) > 0


def media_codecs(producers: Iterable[Mapping[str, Any]]) -> list[str]:
    """Return the codec names the producers offer, in order, without repeats.

    go2rtc prints a media as `video, recvonly, H264 High 4.1` or
    `audio, recvonly, PCMA/8000, PCMU/8000`; the codec is the first word of
    each entry after the direction.
    """
    codecs: list[str] = []
    for producer in producers:
        medias = producer.get("medias")
        for media in medias if isinstance(medias, list) else []:
            if not isinstance(media, str):
                continue
            for entry in media.split(",")[2:]:
                match = _CODEC.match(entry.strip().split("/")[0])
                if match and match.group(0) not in codecs:
                    codecs.append(match.group(0))
    return codecs[:MAX_CODECS]


def missing_stream(name: str, sources: Iterable[str] = ()) -> StreamState:
    """Describe a stream a camera refers to that go2rtc does not have."""
    first = next(iter(sources), None)
    return {
        "name": name,
        "configured": False,
        "connected": False,
        "bytes_received": 0,
        "bytes_per_second": None,
        "producers": 0,
        "consumers": 0,
        "codecs": [],
        "source": safe_source(first) if first is not None else None,
    }


def reduce_stream(name: str, data: object) -> StreamState:
    """Reduce one entry of go2rtc's `/api/streams` to its display-safe state.

    Args:
        name: The stream name.
        data: go2rtc's entry for it, with `producers` and `consumers`.

    Returns:
        The stream state. `connected` is true when any producer has medias or
        has received bytes; `source` describes the connected producer, or the
        first one when none is connected. `bytes_per_second` is filled in by
        the reader, which has the previous sample.
    """
    entry = data if isinstance(data, Mapping) else {}
    producers = _items(entry.get("producers"))
    live = [producer for producer in producers if _producer_connected(producer)]
    shown = next(
        (producer for producer in [*live, *producers] if producer.get("url")), None
    )

    return {
        "name": name,
        "configured": True,
        "connected": bool(live),
        "bytes_received": sum(_producer_bytes(producer) for producer in producers),
        "bytes_per_second": None,
        "producers": len(producers),
        "consumers": len(_items(entry.get("consumers"))),
        "codecs": media_codecs(live),
        "source": safe_source(shown["url"]) if shown else None,
    }


def fetch_streams(
    url: str = GO2RTC_STREAMS_URL, timeout: float = FETCH_TIMEOUT_SECONDS
) -> dict[str, Any] | None:
    """Read go2rtc's stream list.

    Returns:
        The streams by name, or None when go2rtc cannot be reached or answers
        with something other than a JSON object.
    """
    try:
        response = requests.get(url, timeout=timeout)
    except RequestException as error:
        logger.debug("go2rtc is not reachable: %s", type(error).__name__)
        return None

    if not response.ok:
        logger.debug("go2rtc answered %s for its stream list", response.status_code)
        return None

    try:
        payload = response.json()
    except ValueError:
        logger.debug("go2rtc returned a stream list that is not JSON")
        return None

    return payload if isinstance(payload, dict) else None


class RateTracker:
    """Turns a stream's running byte counter into bytes per second.

    It remembers the previous sample per stream. The first sample has nothing
    to compare with, and a counter that went backwards means go2rtc
    reconnected or restarted, so both give None.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._previous: dict[str, tuple[float, int]] = {}

    def sample(self, name: str, total: int, now: float) -> float | None:
        """Record a counter reading and return the rate since the last one.

        Args:
            name: The stream name.
            total: Bytes received so far.
            now: Monotonic time of the reading, in seconds.

        Returns:
            Bytes per second, or None when no rate can be derived.
        """
        with self._lock:
            previous = self._previous.get(name)
            self._previous[name] = (now, total)

        if previous is None:
            return None

        elapsed = now - previous[0]
        if elapsed <= 0 or total < previous[1]:
            return None

        return round((total - previous[1]) / elapsed, 1)

    def keep(self, names: Iterable[str]) -> None:
        """Forget every stream that is not in `names`."""
        wanted = set(names)
        with self._lock:
            for name in [key for key in self._previous if key not in wanted]:
                del self._previous[name]


class Go2rtcStateReader:
    """Reads go2rtc's stream list, reduced and cached for a few seconds.

    One instance lives on the app. The lock is held across the fetch, so
    concurrent requests share one call to go2rtc instead of each making one.
    Only reduced states are kept, never go2rtc's raw answer.
    """

    def __init__(
        self,
        fetch: Callable[[], dict[str, Any] | None] = fetch_streams,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        cache_seconds: float = CACHE_SECONDS,
    ) -> None:
        self._fetch = fetch
        self._clock = clock
        self._wall_clock = wall_clock
        self._cache_seconds = cache_seconds
        self._lock = threading.Lock()
        self._rates = RateTracker()
        self._cached: tuple[float, dict[str, Any]] | None = None

    def read(self) -> dict[str, Any]:
        """Return the current snapshot, refetching when the cache has expired.

        Returns:
            `available` (go2rtc answered), `updated` (unix time of the fetch)
            and `streams`, the reduced state of every go2rtc stream by name.
        """
        with self._lock:
            now = self._clock()
            if self._cached is not None and now - self._cached[0] < self._cache_seconds:
                return self._cached[1]

            payload = self._fetch()
            streams: dict[str, StreamState] = {}
            for name, data in (payload or {}).items():
                state = reduce_stream(str(name), data)
                state["bytes_per_second"] = self._rates.sample(
                    state["name"], state["bytes_received"], now
                )
                streams[state["name"]] = state
            # An unreachable go2rtc drops every sample too: its counters
            # restart from zero when it comes back.
            self._rates.keep(streams)

            snapshot = {
                "available": payload is not None,
                "updated": self._wall_clock(),
                "streams": streams,
            }
            self._cached = (now, snapshot)
            return snapshot


def camera_states(
    snapshot: Mapping[str, Any],
    stream_names: Mapping[str, Iterable[str]],
    sources: Mapping[str, list[str]],
) -> dict[str, Any]:
    """Shape a snapshot into the per-camera response.

    Args:
        snapshot: What `Go2rtcStateReader.read` returned.
        stream_names: The streams of each camera the caller may see.
        sources: Raw config sources per stream, used to describe a stream
            go2rtc does not have.

    Returns:
        The response body. When go2rtc is unavailable no camera is listed.
    """
    cameras: dict[str, Any] = {}
    if snapshot["available"]:
        streams = snapshot["streams"]
        for camera, names in stream_names.items():
            cameras[camera] = {
                "streams": [
                    streams.get(name) or missing_stream(name, sources.get(name, []))
                    for name in names
                ]
            }

    return {
        "available": bool(snapshot["available"]),
        "updated": snapshot["updated"],
        "cameras": cameras,
    }
