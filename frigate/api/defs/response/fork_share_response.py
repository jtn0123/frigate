from pydantic import BaseModel, Field


class ShareLinkResponse(BaseModel):
    """A clip share link together with the event it points at."""

    token: str = Field(description="Secret token that identifies the link")
    url: str = Field(description="Path of the public share page for the link")
    expires_at: float = Field(description="Unix timestamp when the link expires")
    event_id: str = Field(description="ID of the shared event")
    camera: str = Field(description="Camera the shared event belongs to")
    label: str = Field(description="Label of the shared event")
    start_time: float = Field(description="Unix timestamp when the event started")
    end_time: float | None = Field(
        default=None,
        description="Unix timestamp when the event ended, null while it is ongoing",
    )
    has_clip: bool = Field(description="Whether the event has a clip to play")


class ShareLinkListItem(BaseModel):
    """An active clip share link as listed for its creator or an admin."""

    token: str = Field(description="Secret token that identifies the link")
    url: str = Field(description="Path of the public share page for the link")
    event_id: str = Field(description="ID of the shared event")
    camera: str = Field(description="Camera the shared event belongs to")
    created_by: str = Field(description="Username that created the link")
    created_at: float = Field(description="Unix timestamp when the link was created")
    expires_at: float = Field(description="Unix timestamp when the link expires")


ShareLinkListResponse = list[ShareLinkListItem]
