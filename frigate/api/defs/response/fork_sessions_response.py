from pydantic import BaseModel, Field


class SessionListItem(BaseModel):
    """A signed-in session that can still be used (fork E26)."""

    id: str = Field(description="Session id, the jti claim of its tokens")
    username: str = Field(description="User the session belongs to")
    created_at: float = Field(description="Unix timestamp of the sign-in")
    last_seen: float = Field(
        description="Unix timestamp of the last request the session made"
    )
    expires_at: float = Field(
        description="Unix timestamp when the session ends unless it is refreshed"
    )
    user_agent: str = Field(
        description="User agent of the sign-in request, empty when unknown"
    )
    ip: str = Field(description="Client address of the sign-in, empty when unknown")
    current: bool = Field(description="Whether this is the caller's own session")


SessionListResponse = list[SessionListItem]


class SessionRevokeAllResponse(BaseModel):
    """Result of signing a user out of several sessions at once."""

    success: bool
    revoked: int = Field(description="Number of sessions revoked")


class SessionPushResponse(BaseModel):
    """Result of tying a device's push subscription to its session (fork E27)."""

    success: bool
    linked: bool = Field(
        description="Whether the subscription is this user's and now follows this session"
    )
