from pydantic import Field

from ..base import FrigateBaseModel
from ..fork.notification_schedule import QuietHoursWindow

__all__ = ["NotificationConfig"]


class NotificationConfig(FrigateBaseModel):
    enabled: bool = Field(
        default=False,
        title="Enable notifications",
        description="Enable or disable notifications for all cameras; can be overridden per-camera.",
    )
    email: str | None = Field(
        default=None,
        title="Notification email",
        description="Email address used for push notifications or required by certain notification providers.",
    )
    cooldown: int = Field(
        default=0,
        ge=0,
        title="Cooldown period",
        description="Cooldown (seconds) between notifications to avoid spamming recipients.",
    )
    # fork (D78): server-side schedule for when alert pushes are held back
    quiet_hours: list[QuietHoursWindow] = Field(
        default_factory=list,
        title="Quiet hours",
        description="Times when review alert and trigger push notifications are not sent. Times use the UI timezone when one is set, otherwise the server's local time. A camera's own list replaces the global one.",
    )
    enabled_in_config: bool | None = Field(
        default=None,
        title="Original notifications state",
        description="Indicates whether notifications were enabled in the original static configuration.",
    )
