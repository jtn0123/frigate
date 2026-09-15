"""Delete clip share links that can no longer be used (fork UI11)."""

import logging
import time

from frigate.models import Event, ShareLink

logger = logging.getLogger(__name__)

# An expired link keeps answering "expired" this long before it is removed and
# reads as unknown, so a late visitor still learns why the clip is gone.
EXPIRED_LINK_GRACE = 7 * 86400


def expire_share_links(now: float | None = None) -> int:
    """Delete links long past expiry and links whose event no longer exists."""
    now = time.time() if now is None else now
    deleted = (
        ShareLink.delete()
        .where(
            (ShareLink.expires_at < now - EXPIRED_LINK_GRACE)
            | ~(ShareLink.event_id << Event.select(Event.id))
        )
        .execute()
    )
    if deleted:
        logger.debug("Deleted %s expired or orphaned share links", deleted)
    return int(deleted)
