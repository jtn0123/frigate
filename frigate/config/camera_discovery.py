"""Administrator-configured destinations for optional camera discovery."""

import re
from typing import Literal

from pydantic import Field, IPvAnyAddress, field_validator

from .base import FrigateBaseModel


class CameraDiscoveryTarget(FrigateBaseModel):
    """Pin a discovery connection to an explicitly authorized camera address."""

    address: IPvAnyAddress = Field(
        title="Camera IP address",
        description="Fixed camera IP for discovery. DNS is not used for connections.",
    )
    scheme: Literal["https", "http"] = Field(
        default="https",
        title="Camera API transport",
        description="HTTPS verifies the camera certificate. HTTP is only for cameras without TLS and sends credentials without encryption.",
    )
    port: int | None = Field(
        default=None,
        ge=1,
        le=65535,
        title="Camera API port",
        description="Camera API port. Defaults to 443 for HTTPS and 80 for HTTP.",
    )
    server_name: str | None = Field(
        default=None,
        title="Camera certificate hostname",
        description="Hostname for TLS certificate verification and SNI. Connections still use the fixed IP. Defaults to the camera IP.",
    )
    ca_certs: str | None = Field(
        default=None,
        title="Camera CA certificate file",
        description="Optional PEM CA certificate bundle trusted for this camera. System trust is used when omitted. Certificate verification cannot be disabled.",
    )

    @field_validator("address")
    @classmethod
    def validate_address(cls, address: IPvAnyAddress) -> IPvAnyAddress:
        """Reject local services, metadata endpoints, and non-unicast targets."""
        effective = getattr(address, "ipv4_mapped", None) or address
        if (
            effective.is_loopback
            or effective.is_link_local
            or effective.is_unspecified
            or effective.is_multicast
            or effective.is_reserved
        ):
            raise ValueError("Discovery requires a unicast camera address")
        return address

    @field_validator("server_name")
    @classmethod
    def validate_server_name(cls, name: str | None) -> str | None:
        """Allow only a hostname in TLS and HTTP host headers."""
        if name is not None and re.fullmatch(r"[a-zA-Z0-9.-]+", name) is None:
            raise ValueError("Camera server name must be a hostname")
        return name
