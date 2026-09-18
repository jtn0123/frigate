"""Fork: response models for the fork's own `fork_updates` endpoint.

The fork asks upstream to declare `response_model` on its routes (B2 in
fork/GRADE-REPORT.md); this router is fork-owned end to end, so its shape is
exact in the OpenAPI spec and in the generated frontend types. The share
router's models live in `fork_share_response.py`.
"""

from pydantic import BaseModel, Field


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
