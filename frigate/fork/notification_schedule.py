"""Fork (D78): whether a camera's push notifications are in their quiet hours.

Windows are compared on the local wall clock of the schedule's timezone, so a
22:00 to 07:00 window stays 22:00 to 07:00 across daylight saving changes: on
the night the clocks spring forward it is an hour shorter, and on the night
they fall back an hour longer. A window that starts in the hour a spring
forward skips begins when the clock reaches its start, at 03:00.
"""

import datetime as dt
import logging
from collections.abc import Sequence
from typing import Literal
from zoneinfo import ZoneInfoNotFoundError

from tzlocal import get_localzone

from frigate.config import FrigateConfig
from frigate.config.fork.notification_schedule import WEEKDAYS, QuietHoursWindow
from frigate.util.time import get_timezone

logger = logging.getLogger(__name__)

TimezoneSource = Literal["ui", "server"]


def _minute_of_day(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def _starts_on(window: QuietHoursWindow, weekday: int) -> bool:
    return not window.days or WEEKDAYS[weekday] in window.days


def is_quiet(
    now: dt.datetime, windows: Sequence[QuietHoursWindow], tz: dt.tzinfo
) -> bool:
    """Return whether `now` falls inside any of the quiet hours windows.

    Args:
        now: The moment to test. A naive datetime is read as the server's
            local time.
        windows: The quiet hours windows of one camera.
        tz: The timezone whose wall clock the windows are written in.

    Returns:
        True when push notifications should be held back.
    """
    local = now.astimezone(tz)
    minute = local.hour * 60 + local.minute
    today = local.weekday()
    yesterday = (today - 1) % 7

    for window in windows:
        start = _minute_of_day(window.start)
        end = _minute_of_day(window.end)

        if start < end:
            if _starts_on(window, today) and start <= minute < end:
                return True
            continue

        # end at or before start: the window runs past midnight (equal
        # times make it a full day), and belongs to the day it starts on
        if _starts_on(window, today) and minute >= start:
            return True
        if _starts_on(window, yesterday) and minute < end:
            return True

    return False


def resolve_timezone(
    ui_timezone: str | None,
) -> tuple[dt.tzinfo, str, TimezoneSource]:
    """Pick the timezone quiet hours are read in.

    Args:
        ui_timezone: The configured `ui.timezone`, if any.

    Returns:
        The timezone, its IANA name, and whether it came from the UI config
        or is the server's local time.
    """
    if ui_timezone:
        try:
            zone = get_timezone(ui_timezone)
        except (ZoneInfoNotFoundError, ValueError):
            logger.debug(
                "ui.timezone %s is not a known timezone, using server time",
                ui_timezone,
            )
        else:
            return zone, zone.key, "ui"

    try:
        local = get_localzone()
    except ZoneInfoNotFoundError:
        logger.debug("Server timezone is not set, using UTC for quiet hours")
        return dt.UTC, "UTC", "server"

    return local, str(local), "server"


def in_quiet_hours(
    config: FrigateConfig, camera: str, now: dt.datetime | None = None
) -> bool:
    """Return whether a camera's alert pushes are held back right now.

    The camera's `notifications.quiet_hours` already holds the global list
    when the camera sets none of its own, and an active profile's list when
    the profile overrides it.

    Args:
        config: The config the push client is running with.
        camera: The camera the notification is for.
        now: The moment to test; the current time when omitted.

    Returns:
        True when the notification should not be sent.
    """
    camera_config = config.cameras.get(camera)
    if camera_config is None or not camera_config.notifications.quiet_hours:
        return False

    tz, _, _ = resolve_timezone(config.ui.timezone)
    quiet = is_quiet(
        now or dt.datetime.now(dt.UTC), camera_config.notifications.quiet_hours, tz
    )
    if quiet:
        logger.debug("Skipping notification for %s: inside its quiet hours", camera)
    return quiet
