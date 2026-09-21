"""Public, credential-free live-stream diagnostic response contract."""

from typing import Literal

from pydantic import BaseModel, Field


class StreamDiagnosticsResponse(BaseModel):
    """Available stream probe measurements."""

    id: str
    stream: str
    status: Literal[
        "healthy", "decode_error", "stream_unavailable", "timeout", "unavailable"
    ]
    codecs: list[str]
    elapsed_ms: int = Field(ge=0)
    producer_count: int | None = Field(default=None, ge=0)
    received_bytes: int | None = Field(default=None, ge=0)
    decoded_frames: int | None = Field(default=None, ge=0)
    decoder_errors: int | None = Field(default=None, ge=0)
    decoder_detail: str | None = Field(default=None, max_length=1600)
