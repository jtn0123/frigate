"""Camera queries with server-configured, IP-pinned destinations."""

import ssl
from typing import Any
from urllib.parse import urlencode

from urllib3 import HTTPConnectionPool, HTTPSConnectionPool

from frigate.config.camera_discovery import CameraDiscoveryTarget


def query_reolink(
    target: CameraDiscoveryTarget, username: str, password: str
) -> tuple[int, Any]:
    """Query an authorized camera without DNS, proxy, or redirect retargeting."""
    address = str(target.address)
    port = target.port or (443 if target.scheme == "https" else 80)
    server_name = target.server_name or address
    # Bracket IPv6 literals in the HTTP authority, not in socket addresses.
    authority = f"[{server_name}]" if ":" in server_name else server_name
    headers = {"Host": f"{authority}:{port}"}
    pool: HTTPConnectionPool
    if target.scheme == "https":
        pool = HTTPSConnectionPool(
            address,
            port=port,
            timeout=5,
            server_hostname=server_name,
            assert_hostname=server_name,
            cert_reqs="CERT_REQUIRED",
            ssl_minimum_version=ssl.TLSVersion.TLSv1_2,
            ca_certs=target.ca_certs,
        )
    else:
        # HTTP is an explicit per-camera compatibility choice, never a fallback.
        pool = HTTPConnectionPool(address, port=port, timeout=5)
    path = "/api.cgi?" + urlencode(
        {"cmd": "GetEnc", "user": username, "password": password}
    )
    with pool:
        response = pool.request(
            "GET", path, headers=headers, redirect=False, retries=False
        )
        return (
            response.status,
            response.json() if 200 <= response.status < 300 else None,
        )


def get_reolink_main_stream(data: Any) -> dict[str, Any] | None:
    """Extract the main stream from supported Reolink response shapes."""
    data = data[0] if isinstance(data, list) and data else data
    if not isinstance(data, dict):
        return None
    value = data.get("value")
    stream = value.get("Enc") if isinstance(value, dict) else None
    if not stream:
        stream = data.get("Enc")
    if not isinstance(stream, dict):
        return None
    main_stream = stream.get("mainStream")
    return main_stream if isinstance(main_stream, dict) else None
