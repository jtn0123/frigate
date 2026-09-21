"""Public contracts for camera-authorized companion audio results."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SoundResult(BaseModel):
    """A raw suggestion, not a probability."""

    model_config = ConfigDict(allow_inf_nan=False)
    label: str = Field(max_length=200)
    similarity: float


class StageResult(BaseModel):
    """Expose state without internal error details."""

    status: str = Field(max_length=40)


class AudioAnalysis(BaseModel):
    """Bounded public audio analysis."""

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


class AudioResultsResponse(BaseModel):
    """Audio availability and bounded chunks."""

    model_config = ConfigDict(allow_inf_nan=False)
    status: Literal["available", "not_available", "unavailable"]
    updated: float | None = None
    chunks: list[AudioChunk] = Field(max_length=100)
