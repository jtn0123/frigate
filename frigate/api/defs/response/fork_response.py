"""Fork: response models for the fork's own endpoints (fork_share, fork_updates).

The fork asks upstream to declare `response_model` on its routes (B2 in
fork/GRADE-REPORT.md); these two routers are fork-owned end to end, so their
shapes are exact in the OpenAPI spec and in the generated frontend types.
"""

from pydantic import BaseModel, Field


class ShareLinkResponse(BaseModel):
    """A clip share link and the event it points at."""

    token: str = Field(description="Share token; the credential for the link")
    url: str = Field(description="Path the browser opens, relative to the base path")
    expires_at: float = Field(description="Unix timestamp when the link stops working")
    event_id: str = Field(description="Event the clip belongs to")
    camera: str = Field(description="Camera name for the event")
    label: str | None = Field(default=None, description="Object label for the event")
    start_time: float = Field(description="Unix timestamp the event started")
    end_time: float | None = Field(
        default=None, description="Unix timestamp the event ended, if it has"
    )
    has_clip: bool = Field(description="Whether a clip exists for the event")


class ForkReleaseModel(BaseModel):
    """One published fork release carrying a build marker."""

    tag: str = Field(description="Git tag of the release, for example fork/0.18.0-...")
    name: str = Field(description="Release title")
    sha: str = Field(description="Commit the release was built from")
    published_at: str = Field(description="ISO 8601 publication time from GitHub")
    url: str = Field(description="Release page on GitHub")
    notes: str = Field(description="Release notes, with the build marker removed")


class ForkUpdatesResponse(BaseModel):
    """What the running build is, and what the fork has published since."""

    status: str = Field(
        description=(
            "up-to-date, available, development (a build with no matching "
            "release), unknown (releases could not be read), or disabled "
            "(telemetry.version_check is false)"
        )
    )
    repo: str = Field(description="Repository the releases come from")
    current_version: str = Field(description="Version string of the running build")
    current_sha: str | None = Field(
        default=None, description="Commit the running build was stamped with"
    )
    current_tag: str | None = Field(
        default=None, description="Tag of the release the running build matches"
    )
    latest_tag: str | None = Field(
        default=None, description="Tag of the newest published release"
    )
    newer_count: int = Field(
        description="Releases published after the running build", ge=0
    )
    releases: list[ForkReleaseModel] = Field(description="Releases, newest first")
    checked_at: float | None = Field(
        default=None, description="Unix timestamp of the last successful check"
    )
    error: str | None = Field(
        default=None, description="Why the last check failed, if it did"
    )
