"""Fork (I58): collapse repeated warning and error log lines per camera and hour.

A camera that keeps failing writes the same few lines thousands of times (one
dead WiFi doorbell produced 31,734 go2rtc timeouts and about 680,000 watchdog
lines in two weeks), which buries everything else in the Logs page. This
module reads the tail of the frigate and go2rtc logs and groups those lines by
camera, hour and normalized message. It only reads: nothing about what gets
written to the logs changes.

go2rtc lines carry camera URLs with credentials, so every message is redacted
before it is grouped, and the camera is worked out from the raw line without
ever returning the URL that matched.
"""

import logging
import os
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

LOG_PATHS: dict[str, str] = {
    "frigate": "/dev/shm/logs/frigate/current",
    "go2rtc": "/dev/shm/logs/go2rtc/current",
}

DEFAULT_HOURS = 24
MAX_HOURS = 168
DEFAULT_MIN_COUNT = 2
DEFAULT_MAX_MB = 10
DEFAULT_MAX_GROUPS = 200
# Distinct (camera, hour, service, signature) keys tracked while reading. A
# log whose lines do not normalize to a few signatures stops adding keys here
# instead of growing without bound.
MAX_TRACKED_GROUPS = 20000
EXAMPLE_CHARS = 200
SIGNATURE_CHARS = 300
_PARSE_CACHE_MAX = 4096

# Levels kept by default. INFO is only kept for `watchdog.<camera>` (see
# `summarize_logs`), because the watchdog reports the restart loop at INFO.
DEFAULT_LEVELS: frozenset[str] = frozenset({"warning", "error"})
_LEVEL_RANK = {"info": 0, "warning": 1, "error": 2}
_FRIGATE_LEVELS = {
    "INFO": "info",
    "WARNING": "warning",
    "ERROR": "error",
    "CRITICAL": "error",
}
_GO2RTC_LEVELS = {
    "INF": "info",
    "WRN": "warning",
    "ERR": "error",
    "FTL": "error",
    "PNC": "error",
}
# Loggers named `<prefix>.<camera>[.<role>]`.
_CAMERA_LOGGERS = frozenset({"watchdog", "ffmpeg", "audio"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})

# Mirrors `_VOLATILE` in frigate/video/restart_log.py. That one is private and
# importing its module pulls in the camera config and the hwaccel fallback
# state, so the pattern is repeated here rather than imported.
_VOLATILE = re.compile(r"0x[0-9a-f]+|\d+")

# A URL-like token runs to the next whitespace. The greedy `\S*@` takes the
# userinfo up to the LAST "@", so a password holding "@", "/" or a quote does
# not leave its tail behind.
_URL = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*)://(?:\S*@)?(\S*)")
_HOST = re.compile(r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._\-]+)(:\d{1,5}(?!\d))?")
_PATH = re.compile(r"/[A-Za-z0-9._~/\-]*")
_UNTRUSTED_AFTER_HOST = re.compile(r"[:@A-Za-z0-9]")
# "nest:?client_id=..." style sources have a query string without "://".
_BARE_QUERY = re.compile(r"\?[\w.%\-]+=\S*")
_SECRET_PAIR = re.compile(
    r"(?i)\b([\w.\-]*(?:user|pass|pwd|token|secret|auth|key|credential)[\w.\-]*)=\S+"
)
# What is left of "user:pa ss@host" once the URL itself is gone.
_DANGLING_USERINFO = re.compile(r"\S+@(?=[\w\[])")
_REDACTED_URL = "<redacted>"


def redact(message: str) -> str:
    """Remove credentials and query strings from a log message.

    Stricter than `clean_camera_user_pass`: the userinfo of every URL-like
    token is dropped rather than masked, the query string and fragment are
    dropped entirely, only a plain path survives, and `key=value` pairs whose
    key looks like a credential lose their value.

    Args:
        message: The message part of one log line.

    Returns:
        The message with nothing secret left in it.
    """
    # go2rtc quotes ffmpeg's output, so line breaks arrive as a literal "\n";
    # frigate joins multi-line messages with a zero-width space.
    text = message.replace("\\n", " ").replace("​", " ")
    if "://" in text:
        text = _URL.sub(_redact_url, text)
    if "?" in text:
        text = _BARE_QUERY.sub("", text)
    if "=" in text:
        text = _SECRET_PAIR.sub(r"\1=*", text)
    if "@" in text:
        text = _DANGLING_USERINFO.sub("", text)
    return text


def _redact_url(match: re.Match[str]) -> str:
    scheme, rest = match.group(1), match.group(2)
    # Keep a closing quote so `error="... rtsp://host/x"` stays balanced.
    closing = rest[-1] if rest[-1:] in ('"', "'") else ""
    host = _HOST.match(rest)
    if host is None or _UNTRUSTED_AFTER_HOST.match(rest, host.end()):
        # "user:password" with the "@host" cut off by whitespace looks like
        # "host:port" with a port that is not a number: trust none of it.
        return f"{scheme}://{_REDACTED_URL}{closing}"
    path = _PATH.match(rest, host.end())
    return f"{scheme}://{host.group(0)}{path.group(0) if path else ''}{closing}"


def normalize(message: str) -> str:
    """Return the signature that repeated lines share.

    Numbers and hex pointers (ports, addresses, timestamps, durations) become
    "#", the way `RestartLog` tells one ffmpeg failure from another.

    Args:
        message: An already redacted message.

    Returns:
        The signature, bounded in length.
    """
    return _VOLATILE.sub("#", message)[:SIGNATURE_CHARS]


def _url_hosts(text: str) -> Iterator[tuple[str, str]]:
    """Yield (host, last path segment) for each URL-like token in a source."""
    for match in _URL.finditer(text):
        rest = match.group(2)
        host = _HOST.match(rest)
        if host is None:
            continue
        path = _PATH.match(rest, host.end())
        segment = path.group(0).rstrip("/").rsplit("/", 1)[-1] if path else ""
        yield host.group(1).lower(), segment


class CameraMatcher:
    """Attribute a log line to a camera by a name, stream name or host in it.

    The tokens come from the config (camera names, go2rtc stream names and the
    hosts of each camera's sources). A token two cameras share, like the host
    of a recorder serving several channels, attributes to neither. Only the
    camera name ever leaves this class, never the token or a URL.
    """

    def __init__(self, tokens: Mapping[str, str | None] | None = None) -> None:
        self._tokens: dict[str, str | None] = {
            token.lower(): camera for token, camera in (tokens or {}).items() if token
        }
        self._pattern: re.Pattern[str] | None = None
        if self._tokens:
            alternatives = "|".join(
                re.escape(token)
                for token in sorted(self._tokens, key=len, reverse=True)
            )
            # Not inside a longer name, host or number: "garage" must not match
            # "garage_2", nor "10.0.0.4" match "10.0.0.42".
            self._pattern = re.compile(
                rf"(?<![\w.\-])(?:{alternatives})(?![\w\-])(?!\.\w)", re.IGNORECASE
            )

    @classmethod
    def from_config(cls, config: Any) -> "CameraMatcher":
        """Build the matcher from a Frigate config.

        Args:
            config: The `FrigateConfig` (read with getattr, so a partial
                stand-in works in tests).

        Returns:
            A matcher knowing every camera name, the go2rtc streams each
            camera uses and the hosts those read from.
        """
        cameras = getattr(config, "cameras", None) or {}
        tokens: dict[str, str | None] = {}
        stream_owner: dict[str, str | None] = {}

        def claim(target: dict[str, str | None], token: str, camera: str) -> None:
            key = token.lower()
            if key and target.setdefault(key, camera) != camera:
                target[key] = None

        for name, camera in cameras.items():
            claim(stream_owner, name, name)
            live = getattr(getattr(camera, "live", None), "streams", None)
            if isinstance(live, Mapping):
                for stream in live.values():
                    claim(stream_owner, str(stream), name)
            inputs = getattr(getattr(camera, "ffmpeg", None), "inputs", None) or []
            for camera_input in inputs:
                for host, segment in _url_hosts(str(getattr(camera_input, "path", ""))):
                    if host in _LOOPBACK_HOSTS:
                        # A restream input: the path names the go2rtc stream.
                        claim(stream_owner, segment, name)
                    else:
                        claim(tokens, host, name)

        for stream, sources in _go2rtc_streams(config).items():
            owner = stream_owner.get(stream.lower())
            if owner is None:
                continue
            for source in sources:
                for host, _segment in _url_hosts(source):
                    if host not in _LOOPBACK_HOSTS:
                        claim(tokens, host, owner)

        for stream, owner in stream_owner.items():
            if owner is not None:
                claim(tokens, stream, owner)
        # A camera's own name always means that camera.
        for name in cameras:
            tokens[name.lower()] = name
        return cls(tokens)

    def match(self, text: str) -> str | None:
        """Return the camera a line is about, or None when none is named.

        Args:
            text: The raw (not yet redacted) line or message.

        Returns:
            The camera name, or None.
        """
        if self._pattern is None:
            return None
        for found in self._pattern.finditer(text):
            camera = self._tokens.get(found.group(0).lower())
            if camera is not None:
                return camera
        return None


def _go2rtc_streams(config: Any) -> dict[str, list[str]]:
    go2rtc = getattr(config, "go2rtc", None)
    if go2rtc is None:
        return {}
    dumped = go2rtc.model_dump() if hasattr(go2rtc, "model_dump") else go2rtc
    streams = dumped.get("streams") if isinstance(dumped, Mapping) else None
    if not isinstance(streams, Mapping):
        return {}
    result: dict[str, list[str]] = {}
    for name, sources in streams.items():
        if isinstance(sources, str):
            result[str(name)] = [sources]
        elif isinstance(sources, Iterable):
            result[str(name)] = [str(source) for source in sources]
    return result


# (camera, level, redacted message, signature) of one kept line
_Parsed = tuple[str | None, str, str, str]


@dataclass
class _Group:
    count: int
    first: float
    last: float
    level: str
    message: str


@dataclass
class _Source:
    """What one log file contributed."""

    available: bool = False
    partial: bool = False
    lines: int = 0
    covered_from: float | None = None
    covered_to: float | None = None


@dataclass
class _State:
    since: float
    since_stamp: str
    levels: frozenset[str]
    watchdog_info: bool
    camera: str | None
    matcher: CameraMatcher
    groups: dict[tuple[str | None, float, str, str], _Group] = field(
        default_factory=dict
    )
    totals: dict[str, int] = field(default_factory=dict)
    total: int = 0
    unattributed: int = 0
    overflow: bool = False
    # "YYYY-MM-DD HH" -> epoch seconds of that local hour
    hours: dict[str, float] = field(default_factory=dict)


def _line_time(line: str, hours: dict[str, float]) -> float | None:
    """Epoch seconds of the s6 timestamp a line starts with, local time.

    Only the hour is converted (and cached); minutes and seconds are added, so
    no line pays for a full date parse.
    """
    hour_key = line[:13]
    try:
        base = hours.get(hour_key)
        if base is None:
            base = datetime(
                int(line[0:4]),
                int(line[5:7]),
                int(line[8:10]),
                int(line[11:13]),
            ).timestamp()
            hours[hour_key] = base
        return base + int(line[14:16]) * 60 + int(line[17:19])
    except ValueError:
        return None


def _parse_frigate(body: str, state: _State) -> _Parsed | None:
    """Parse "logger LEVEL : message" into its kept parts."""
    head, separator, message = body.partition(": ")
    names = head.split()
    if not separator or len(names) != 2:
        return None
    logger_name, level_name = names
    level = _FRIGATE_LEVELS.get(level_name)
    if level is None:
        return None
    parts = logger_name.split(".")
    camera = parts[1] if len(parts) > 1 and parts[0] in _CAMERA_LOGGERS else None
    if level not in state.levels and not (
        state.watchdog_info and level == "info" and parts[0] == "watchdog" and camera
    ):
        return None
    if camera is None:
        camera = state.matcher.match(message)
    message = redact(message.strip())
    return camera, level, message, normalize(message)


def _parse_go2rtc(body: str, state: _State) -> _Parsed | None:
    """Parse "LVL message" into its kept parts."""
    level_name, _separator, message = body.partition(" ")
    level = _GO2RTC_LEVELS.get(level_name)
    if level is None or level not in state.levels or not message:
        return None
    camera = state.matcher.match(message)
    message = redact(message.strip())
    return camera, level, message, normalize(message)


def _frigate_body(tail: str) -> str | None:
    """Drop the "[date] " a frigate line repeats after the s6 timestamp."""
    close = tail.find("] ")
    return tail[close + 2 :] if tail.startswith("[") and close != -1 else None


def _go2rtc_body(tail: str) -> str | None:
    """Drop the "HH:MM:SS.mmm " go2rtc writes after the s6 timestamp."""
    _clock, separator, body = tail.partition(" ")
    return body if separator else None


_PARSERS = {
    "frigate": (_frigate_body, _parse_frigate),
    "go2rtc": (_go2rtc_body, _parse_go2rtc),
}


def _needles(service: str, state: _State) -> tuple[str, ...]:
    """Substrings one of which a kept line must contain (a cheap first cut)."""
    if service == "go2rtc":
        return tuple(
            f" {name} "
            for name, level in _GO2RTC_LEVELS.items()
            if level in state.levels
        )
    wanted = tuple(
        name for name, level in _FRIGATE_LEVELS.items() if level in state.levels
    )
    return (*wanted, "watchdog.") if state.watchdog_info else wanted


def _read_lines(path: str, max_bytes: int, source: _Source) -> Iterator[str]:
    """Yield the lines in the last `max_bytes` of a file.

    Undecodable bytes are replaced, and the first line is dropped when the
    read starts mid-file because it is almost certainly cut.
    """
    try:
        handle = open(path, "rb")
    except OSError:
        logger.debug("Log file %s is not readable", path)
        return
    with handle:
        source.available = True
        size = os.fstat(handle.fileno()).st_size
        if size > max_bytes:
            source.partial = True
            handle.seek(size - max_bytes)
            handle.readline()
        for raw in handle:
            yield raw.decode("utf-8", errors="replace")


def _consume(service: str, path: str, max_bytes: int, state: _State) -> _Source:
    """Count one log file's kept lines into `state`."""
    source = _Source()
    body_of, parser = _PARSERS[service]
    needles = _needles(service, state)
    # The body means different things to the two parsers, so the cache of
    # parsed bodies starts over for each file.
    parsed_cache: dict[str, _Parsed | None] = {}
    for line in _read_lines(path, max_bytes, source):
        source.lines += 1
        # The s6 timestamp sorts as text, so lines before the window are
        # skipped without parsing anything.
        if source.covered_from is not None and line[:19] < state.since_stamp:
            continue
        when = _line_time(line, state.hours)
        if when is None:
            continue
        if source.covered_from is None:
            source.covered_from = when
        source.covered_to = when
        if when < state.since:
            continue
        if not any(needle in line for needle in needles):
            continue
        split = line.find("  ", 19)
        if split == -1:
            continue
        body = body_of(line[split:].strip())
        if body is None:
            continue
        if body in parsed_cache:
            parsed = parsed_cache[body]
        else:
            parsed = parser(body, state)
            # A flood repeats the same body, so this spares the redaction and
            # the camera matching for nearly every line.
            if len(parsed_cache) >= _PARSE_CACHE_MAX:
                parsed_cache.clear()
            parsed_cache[body] = parsed
        if parsed is None:
            continue
        camera, level, message, signature = parsed
        if state.camera is not None and camera != state.camera:
            continue
        _count(state, service, camera, level, message, signature, when, line[:13])
    return source


def _count(
    state: _State,
    service: str,
    camera: str | None,
    level: str,
    message: str,
    signature: str,
    when: float,
    hour_key: str,
) -> None:
    state.total += 1
    if camera is None:
        state.unattributed += 1
    else:
        state.totals[camera] = state.totals.get(camera, 0) + 1
    key = (camera, state.hours[hour_key], service, signature)
    group = state.groups.get(key)
    if group is None:
        if len(state.groups) >= MAX_TRACKED_GROUPS:
            state.overflow = True
            return
        state.groups[key] = _Group(1, when, when, level, message[:EXAMPLE_CHARS])
        return
    group.count += 1
    group.last = max(group.last, when)
    group.first = min(group.first, when)
    if _LEVEL_RANK[level] > _LEVEL_RANK[group.level]:
        group.level = level


def summarize_logs(
    *,
    hours: int = DEFAULT_HOURS,
    camera: str | None = None,
    min_count: int = DEFAULT_MIN_COUNT,
    matcher: CameraMatcher | None = None,
    levels: Iterable[str] = DEFAULT_LEVELS,
    watchdog_info: bool = True,
    max_mb: float = DEFAULT_MAX_MB,
    max_groups: int = DEFAULT_MAX_GROUPS,
    paths: Mapping[str, str] | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Group repeated warning and error lines by camera, hour and message.

    Args:
        hours: How far back to look, clamped to 1..168.
        camera: Only count lines attributed to this camera.
        min_count: Leave out groups seen fewer times than this, so a one-off
            line does not clutter the summary.
        matcher: Attributes lines to cameras; without one only the logger
            name (`watchdog.<camera>` and friends) does.
        levels: Levels to keep, from "info", "warning" and "error".
        watchdog_info: Also keep INFO lines of `watchdog.<camera>`. Those are
            the restart loop ("No frames received ... Exiting ffmpeg"), which
            upstream logs at INFO, so without them a dead camera looks quiet.
        max_mb: Megabytes read from the end of each file.
        max_groups: Groups returned; the ones with the highest counts stay.
        paths: Log file per service, `LOG_PATHS` by default.
        now: Current time in epoch seconds (for tests).

    Returns:
        The summary as a plain dict shaped like `LogSummaryResponse`. The logs
        live on tmpfs and rotate, so `covered_from` says how far back the
        lines that were read actually go.
    """
    hours = max(1, min(int(hours), MAX_HOURS))
    end = datetime.now().timestamp() if now is None else now
    since = end - hours * 3600
    state = _State(
        since=since,
        since_stamp=datetime.fromtimestamp(since).strftime("%Y-%m-%d %H:%M:%S"),
        levels=frozenset(level.lower() for level in levels),
        watchdog_info=watchdog_info,
        camera=camera,
        matcher=matcher or CameraMatcher(),
    )
    max_bytes = max(1, int(max_mb * 1024 * 1024))
    sources: dict[str, _Source] = {}
    for service, path in (paths or LOG_PATHS).items():
        if service not in _PARSERS:
            continue
        sources[service] = _consume(service, path, max_bytes, state)

    kept = [
        (key, group)
        for key, group in state.groups.items()
        if group.count >= max(1, min_count)
    ]
    kept.sort(key=lambda item: (-item[1].count, -item[1].last, item[0][3]))
    limit = max(0, max_groups)
    covered = [
        source.covered_from
        for source in sources.values()
        if source.covered_from is not None
    ]
    return {
        "hours": hours,
        "start": since,
        "end": end,
        "covered_from": max(since, min(covered)) if covered else None,
        "sources": {
            service: {
                "available": source.available,
                "partial": source.partial,
                "lines": source.lines,
                "covered_from": source.covered_from,
                "covered_to": source.covered_to,
            }
            for service, source in sources.items()
        },
        "total": state.total,
        "unattributed": state.unattributed,
        "cameras": dict(
            sorted(state.totals.items(), key=lambda item: (-item[1], item[0]))
        ),
        "truncated": state.overflow or len(kept) > limit,
        "groups": [
            {
                "camera": key[0],
                "service": key[2],
                "hour": key[1],
                "level": group.level,
                "count": group.count,
                "first": group.first,
                "last": group.last,
                "message": group.message,
                "signature": key[3],
            }
            for key, group in kept[:limit]
        ],
    }
