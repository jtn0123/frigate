"""Response contracts for commonly used fork settings endpoints."""

from pydantic import BaseModel


class ActiveProfileResponse(BaseModel):
    """Current persisted profile selection."""

    active_profile: str | None


class ProfileListItem(BaseModel):
    """One selectable configuration profile."""

    name: str
    friendly_name: str | None


class ProfilesResponse(ActiveProfileResponse):
    """Available profiles and their latest activation times."""

    profiles: list[ProfileListItem]
    last_activated: dict[str, float]


class FFmpegPresetsResponse(BaseModel):
    """Preset names exposed to the configuration editor."""

    hwaccel_args: list[str]
    input_args: list[str]
    output_args: dict[str, list[str]]
