"""Fork (I60): ping every camera from Frigate and pass the answer on.

Cameras usually sit on a network only Frigate can reach, so an uptime monitor
on another host cannot ping them and should not be given a route to do so.
Frigate can: it pings the host each camera's stream comes from, keeps the
result for the Health drawer and `/api/metrics`, and, when
`FRIGATE_FORK_UPTIME_PUSH` names a push URL for a camera, reports it there.
Only "answered or not" and the round trip time leave Frigate. The camera's
address, its credentials and its stream never do.

A ping is an ICMP echo. Where the container may not open an ICMP socket, or
the camera does not answer echoes, a TCP connect to the stream's port decides
instead: a camera that accepts or refuses the connection is on the network.
"""

import asyncio
import logging
import os
import re
import secrets
import socket
import struct
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypedDict
from urllib.parse import urlsplit, urlunsplit

import aiohttp

from frigate.fork.go2rtc_state import (
    camera_stream_names,
    configured_sources,
    safe_source,
)

logger = logging.getLogger(__name__)

# `camera=url` pairs separated by whitespace or commas. The URL is the push
# URL of an Uptime Kuma "Push" monitor; its query string is ignored.
PUSH_ENV = "FRIGATE_FORK_UPTIME_PUSH"
INTERVAL_SECONDS = 30
# The first round waits for the cameras' streams to be dialed, so a restart
# of Frigate is not what a slow camera's first ping competes with.
START_DELAY_SECONDS = 10
ATTEMPTS = 3
TIMEOUT_SECONDS = 1.0
PUSH_TIMEOUT_SECONDS = 5

ICMP_ECHO_REQUEST = 8
ICMP_ECHO_REPLY = 0
_ICMP_HEADER = struct.Struct("!BBHHH")
_TOKEN_BYTES = 8

_DEFAULT_PORTS = {
    "rtsp": 554,
    "rtsps": 322,
    "rtmp": 1935,
    "http": 80,
    "https": 443,
    "onvif": 80,
    "tapo": 443,
}
_LOOPBACK = frozenset({"127.0.0.1", "localhost", "[::1]"})
_SAFE_SOURCE = re.compile(
    r"(?:[a-z0-9+.-]+:)?([a-z0-9+.-]+)://(\[[0-9a-f:.]+\]|[^:\[\]]+)(?::(\d+))?",
    re.IGNORECASE,
)
_PAIR_SEPARATOR = re.compile(r"[\s,]+")

Target = tuple[str, int | None]
IcmpEcho = Callable[[str, float, int], float | None]
TcpConnect = Callable[[str, int, float], float | None]
PushSender = Callable[[str, Mapping[str, str]], Awaitable[bool]]


class PingState(TypedDict):
    """What one round of pings found for a camera."""

    reachable: bool
    ms: float | None
    loss: float
    method: str
    checked: float


def source_target(source: str) -> Target | None:
    """Return the host and port of a raw source, or None when it has none.

    The source goes through `safe_source` first, so a URL whose host cannot
    be told apart from its credentials gives None rather than a guess.
    """
    match = _SAFE_SOURCE.fullmatch(safe_source(source))
    if match is None:
        return None

    scheme, host, port = match.group(1).lower(), match.group(2), match.group(3)
    if host.lower() in _LOOPBACK:
        return None

    return host.strip("[]"), int(port) if port else _DEFAULT_PORTS.get(scheme)


def camera_targets(config: Any) -> dict[str, Target]:
    """Map every enabled camera to the host its stream comes from.

    The sources of the camera's go2rtc streams are tried first, then its
    ffmpeg inputs. Inputs that read go2rtc's restream are on loopback and are
    skipped, as are sources without a host (`exec:` and references to other
    streams). A camera with no host at all is left out.

    Args:
        config: The Frigate config.

    Returns:
        `(host, port)` per camera; the port is None when the scheme has no
        known default.
    """
    sources = configured_sources(config)
    stream_names = camera_stream_names(config)
    targets: dict[str, Target] = {}

    for name, camera in config.cameras.items():
        if not camera.enabled:
            continue
        candidates = [
            *(
                source
                for stream in stream_names[name]
                for source in sources.get(stream, [])
            ),
            *(item.path for item in camera.ffmpeg.inputs),
        ]
        target = next(filter(None, map(source_target, candidates)), None)
        if target is not None:
            targets[name] = target

    return targets


def push_urls(value: str) -> dict[str, str]:
    """Parse `FRIGATE_FORK_UPTIME_PUSH` into a push URL per camera.

    Entries that are not `camera=http(s)://...` are dropped with a warning
    that names the camera only, because the URL holds the monitor's token.
    Any query string is removed: Uptime Kuma shows the URL with
    `?status=up&msg=OK&ping=` appended, and the real values are sent instead.
    """
    urls: dict[str, str] = {}
    for pair in filter(None, _PAIR_SEPARATOR.split(value.strip())):
        camera, _, url = pair.partition("=")
        parts = urlsplit(url)
        if not camera or parts.scheme not in ("http", "https") or not parts.netloc:
            logger.warning(
                "Ignoring an entry of %s that is not camera=url: %s",
                PUSH_ENV,
                camera or "(no camera)",
            )
            continue
        urls[camera] = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return urls


def _checksum(data: bytes) -> int:
    """Return the internet checksum (RFC 1071) of `data`."""
    if len(data) % 2:
        data += b"\x00"
    total: int = sum(struct.unpack(f"!{len(data) // 2}H", data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return ~total & 0xFFFF


def build_echo(sequence: int, token: bytes) -> bytes:
    """Build an ICMP echo request carrying `token` as its payload."""
    header = _ICMP_HEADER.pack(ICMP_ECHO_REQUEST, 0, 0, 0, sequence)
    checksum = _checksum(header + token)
    return _ICMP_HEADER.pack(ICMP_ECHO_REQUEST, 0, checksum, 0, sequence) + token


def is_reply(data: bytes, sequence: int, token: bytes) -> bool:
    """Say whether `data` is the echo reply to our request.

    A raw socket delivers the IP header in front of the ICMP message and a
    datagram socket on Linux does not, so a leading IPv4 header is skipped.
    The kernel rewrites the identifier of a datagram socket, which is why the
    payload token is what ties a reply to its request.
    """
    if data and data[0] >> 4 == 4:
        data = data[(data[0] & 0x0F) * 4 :]
    if len(data) < _ICMP_HEADER.size:
        return False

    kind, _code, _checksum_value, _identifier, reply_sequence = _ICMP_HEADER.unpack(
        data[: _ICMP_HEADER.size]
    )
    return (
        kind == ICMP_ECHO_REPLY
        and reply_sequence == sequence
        and data[_ICMP_HEADER.size :] == token
    )


def _icmp_socket() -> socket.socket:
    """Open an ICMP socket, unprivileged when the kernel allows it.

    Raises:
        PermissionError: When neither a datagram nor a raw ICMP socket may be
            opened.
    """
    try:
        return socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    except PermissionError:
        return socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)


def icmp_echo(host: str, timeout: float, sequence: int) -> float | None:
    """Send one ICMP echo and wait for its reply.

    Args:
        host: An IPv4 address or a name that resolves to one.
        timeout: Seconds to wait for the reply.
        sequence: The sequence number to send.

    Returns:
        The round trip in seconds, or None when no reply came, the name did
        not resolve or the network refused the packet.

    Raises:
        PermissionError: When this process may not open an ICMP socket.
    """
    try:
        address = socket.gethostbyname(host)
    except OSError:
        return None

    token = secrets.token_bytes(_TOKEN_BYTES)
    with _icmp_socket() as sock:
        started = time.monotonic()
        deadline = started + timeout
        try:
            sock.sendto(build_echo(sequence, token), (address, 0))
            while (remaining := deadline - time.monotonic()) > 0:
                sock.settimeout(remaining)
                data, sender = sock.recvfrom(1024)
                if sender[0] == address and is_reply(data, sequence, token):
                    return time.monotonic() - started
        except PermissionError:
            raise
        except OSError:
            return None
    return None


def tcp_connect(host: str, port: int, timeout: float) -> float | None:
    """Time a TCP connect, counting a refusal as an answer.

    Returns:
        Seconds until the host accepted or refused the connection, or None
        when nothing answered in time.
    """
    started = time.monotonic()
    try:
        socket.create_connection((host, port), timeout=timeout).close()
    except ConnectionRefusedError:
        pass
    except OSError:
        return None
    return time.monotonic() - started


class CameraPinger:
    """Pings camera hosts and remembers whether ICMP is allowed here."""

    def __init__(
        self,
        icmp: IcmpEcho = icmp_echo,
        tcp: TcpConnect = tcp_connect,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._icmp = icmp
        self._tcp = tcp
        self._clock = clock
        self._icmp_allowed = True

    def _echoes(self, host: str) -> list[float | None]:
        if not self._icmp_allowed:
            return []

        replies: list[float | None] = []
        for sequence in range(1, ATTEMPTS + 1):
            try:
                replies.append(self._icmp(host, TIMEOUT_SECONDS, sequence))
            except PermissionError:
                logger.info("ICMP is not permitted here, pinging cameras over TCP")
                self._icmp_allowed = False
                return []
        return replies

    def probe(self, target: Target) -> PingState:
        """Ping one camera host.

        Args:
            target: The host, and the stream port for the TCP fallback.

        Returns:
            Whether it answered, the best round trip in milliseconds, the
            share of attempts that went unanswered, and which method decided.
        """
        host, port = target
        method = "icmp"
        replies = self._echoes(host)

        # No echo came back (or none could be sent): the port still tells
        # whether the camera is on the network.
        if not any(reply is not None for reply in replies) and port is not None:
            method = "tcp"
            replies = [self._tcp(host, port, TIMEOUT_SECONDS) for _ in range(ATTEMPTS)]

        answered = [reply for reply in replies if reply is not None]
        return {
            "reachable": bool(answered),
            "ms": round(min(answered) * 1000, 1) if answered else None,
            "loss": round(1 - len(answered) / len(replies), 2) if replies else 1.0,
            "method": method,
            "checked": self._clock(),
        }


async def ping_cameras(
    pinger: CameraPinger, targets: Mapping[str, Target]
) -> dict[str, PingState]:
    """Ping every target at once, each in its own thread."""
    names = list(targets)
    states = await asyncio.gather(
        *(asyncio.to_thread(pinger.probe, targets[name]) for name in names)
    )
    return dict(zip(names, states))


def push_params(state: PingState) -> dict[str, str]:
    """Return the query Uptime Kuma's push endpoint expects for a result."""
    if not state["reachable"]:
        return {"status": "down", "msg": "No ping reply", "ping": ""}
    return {
        "status": "up",
        "msg": f"Ping reply in {state['ms']} ms",
        "ping": str(state["ms"]),
    }


async def send_push(url: str, params: Mapping[str, str]) -> bool:
    """Report one result to a push URL. The URL is never logged."""
    timeout = aiohttp.ClientTimeout(total=PUSH_TIMEOUT_SECONDS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, params=params) as response:
                return response.status < 400
    except (TimeoutError, aiohttp.ClientError) as error:
        logger.debug("Uptime push failed: %s", type(error).__name__)
        return False


async def push_states(
    urls: Mapping[str, str],
    states: Mapping[str, PingState],
    send: PushSender = send_push,
) -> dict[str, bool]:
    """Push the result of every camera that has a push URL.

    Returns:
        Whether each push was accepted, by camera.
    """
    names = [name for name in urls if name in states]
    accepted = await asyncio.gather(
        *(send(urls[name], push_params(states[name])) for name in names)
    )
    return dict(zip(names, accepted))


async def camera_ping_round(
    app: Any,
    pinger: CameraPinger,
    urls: Mapping[str, str],
    send: PushSender = send_push,
) -> dict[str, PingState]:
    """Ping the cameras once, keep the results on the app and push them."""
    states = await ping_cameras(pinger, camera_targets(app.frigate_config))
    app.state.fork_camera_ping = states
    await push_states(urls, states, send)
    return states


async def camera_ping_sampler(app: Any) -> None:
    """Ping the cameras every 30 seconds for as long as the app runs.

    The push URLs are read here, not at import: the config's
    `environment_vars` block reaches `os.environ` only once the config loads.
    """
    pinger = CameraPinger()
    urls = push_urls(os.environ.get(PUSH_ENV, ""))
    unknown = sorted(set(urls) - set(app.frigate_config.cameras))
    if unknown:
        logger.warning("%s names unknown cameras: %s", PUSH_ENV, ", ".join(unknown))

    await asyncio.sleep(START_DELAY_SECONDS)
    while True:
        try:
            await camera_ping_round(app, pinger, urls)
        except Exception:
            logger.exception("Camera ping round failed")
        await asyncio.sleep(INTERVAL_SECONDS)
