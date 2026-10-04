"""Tests for notification quiet hours (fork D78)."""

import datetime as dt
import json
import os
import unittest
from typing import Any
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import ValidationError

from frigate.config import FrigateConfig
from frigate.config.fork.notification_schedule import QuietHoursWindow
from frigate.config.profile_manager import ProfileManager
from frigate.config.ui import UIConfig
from frigate.const import MODEL_CACHE_DIR
from frigate.fork import notification_schedule as schedule
from frigate.fork.notification_schedule import (
    in_quiet_hours,
    is_quiet,
    resolve_timezone,
)
from frigate.test.test_fork_cov_comms_webpush import (
    NOW,
    WebPushTestBase,
    _config,
    _review,
)

UTC = dt.UTC
NEW_YORK = ZoneInfo("America/New_York")


def _window(start: str, end: str, days: list[str] | None = None) -> QuietHoursWindow:
    return QuietHoursWindow(start=start, end=end, days=days or [])


def _at(text: str, tz: dt.tzinfo = UTC) -> dt.datetime:
    """A moment on the wall clock of `tz`, from "YYYY-MM-DD HH:MM"."""
    return dt.datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=tz)


def _camera(**extra: Any) -> dict[str, Any]:
    camera: dict[str, Any] = {
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
        },
        "detect": {"height": 720, "width": 1280, "fps": 5},
    }
    camera.update(extra)
    return camera


class TestIsQuiet(unittest.TestCase):
    # 2026-01-14 is a Wednesday
    def test_same_day_window_includes_start_and_excludes_end(self) -> None:
        windows = [_window("09:00", "17:00")]
        self.assertFalse(is_quiet(_at("2026-01-14 08:59"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-14 09:00"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-14 16:59"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-14 17:00"), windows, UTC))

    def test_overnight_window_wraps_past_midnight(self) -> None:
        windows = [_window("22:00", "07:00")]
        self.assertFalse(is_quiet(_at("2026-01-14 21:59"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-14 22:00"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-15 00:00"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-15 06:59"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-15 07:00"), windows, UTC))

    def test_overnight_window_belongs_to_the_day_it_starts(self) -> None:
        # Friday night only: 2026-01-16 is a Friday
        windows = [_window("22:00", "07:00", ["fri"])]
        self.assertTrue(is_quiet(_at("2026-01-16 23:00"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-17 03:00"), windows, UTC))
        # Friday morning is the tail of Thursday night, which is not chosen
        self.assertFalse(is_quiet(_at("2026-01-16 03:00"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-17 23:00"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-15 23:00"), windows, UTC))

    def test_days_select_same_day_windows(self) -> None:
        windows = [_window("08:00", "12:00", ["sat", "sun"])]
        self.assertTrue(is_quiet(_at("2026-01-17 09:00"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-18 11:59"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-19 09:00"), windows, UTC))

    def test_equal_start_and_end_is_a_full_day(self) -> None:
        # Monday 07:00 to Tuesday 07:00; 2026-01-12 is a Monday
        windows = [_window("07:00", "07:00", ["mon"])]
        self.assertFalse(is_quiet(_at("2026-01-12 06:59"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-12 07:00"), windows, UTC))
        self.assertTrue(is_quiet(_at("2026-01-13 06:59"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-13 07:00"), windows, UTC))

    def test_any_window_is_enough_and_none_is_never_quiet(self) -> None:
        windows = [_window("01:00", "02:00"), _window("12:00", "13:00")]
        self.assertTrue(is_quiet(_at("2026-01-14 12:30"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-14 03:00"), windows, UTC))
        self.assertFalse(is_quiet(_at("2026-01-14 12:30"), [], UTC))

    def test_windows_are_read_on_the_given_timezone(self) -> None:
        # 03:30 UTC on Thursday is 22:30 on Wednesday in New York
        now = _at("2026-01-15 03:30")
        windows = [_window("22:00", "23:00", ["wed"])]
        self.assertTrue(is_quiet(now, windows, NEW_YORK))
        self.assertFalse(is_quiet(now, windows, UTC))

    def test_spring_forward_night_is_an_hour_shorter(self) -> None:
        # New York skips 02:00 to 03:00 on Sunday 2026-03-08
        nightly = [_window("22:00", "07:00")]
        self.assertTrue(is_quiet(_at("2026-03-08 06:59", NEW_YORK), nightly, NEW_YORK))
        self.assertFalse(is_quiet(_at("2026-03-08 07:00", NEW_YORK), nightly, NEW_YORK))
        # 10:59 and 11:00 UTC are 06:59 and 07:00 EDT
        self.assertTrue(is_quiet(_at("2026-03-08 10:59"), nightly, NEW_YORK))
        self.assertFalse(is_quiet(_at("2026-03-08 11:00"), nightly, NEW_YORK))

    def test_window_starting_in_the_skipped_hour_starts_at_three(self) -> None:
        windows = [_window("02:30", "04:00", ["sun"])]
        # 06:59 UTC is 01:59 EST, the next minute is 03:00 EDT
        self.assertFalse(is_quiet(_at("2026-03-08 06:59"), windows, NEW_YORK))
        self.assertTrue(is_quiet(_at("2026-03-08 07:00"), windows, NEW_YORK))
        self.assertTrue(is_quiet(_at("2026-03-08 07:59"), windows, NEW_YORK))
        self.assertFalse(is_quiet(_at("2026-03-08 08:00"), windows, NEW_YORK))

    def test_fall_back_repeats_the_hour_inside_the_window(self) -> None:
        # New York repeats 01:00 to 02:00 on Sunday 2026-11-01
        windows = [_window("01:00", "02:00", ["sun"])]
        self.assertTrue(is_quiet(_at("2026-11-01 05:30"), windows, NEW_YORK))  # EDT
        self.assertTrue(is_quiet(_at("2026-11-01 06:30"), windows, NEW_YORK))  # EST
        self.assertFalse(is_quiet(_at("2026-11-01 07:00"), windows, NEW_YORK))


class TestResolveTimezone(unittest.TestCase):
    def test_ui_timezone_wins(self) -> None:
        tz, name, source = resolve_timezone("America/Chicago")
        self.assertEqual((name, source), ("America/Chicago", "ui"))
        self.assertEqual(tz, ZoneInfo("America/Chicago"))

    def test_ui_timezone_name_is_case_insensitive(self) -> None:
        _, name, source = resolve_timezone("america/chicago")
        self.assertEqual((name, source), ("America/Chicago", "ui"))

    @patch.object(schedule, "get_localzone", return_value=ZoneInfo("Europe/Berlin"))
    def test_unknown_or_missing_ui_timezone_uses_server_time(self, _local) -> None:
        for ui_timezone in (None, "", "Not/AZone"):
            with self.subTest(ui_timezone=ui_timezone):
                tz, name, source = resolve_timezone(ui_timezone)
                self.assertEqual((name, source), ("Europe/Berlin", "server"))
                self.assertEqual(tz, ZoneInfo("Europe/Berlin"))

    @patch.object(schedule, "get_localzone", side_effect=ZoneInfoNotFoundError("x"))
    def test_unreadable_server_timezone_is_utc(self, _local) -> None:
        self.assertEqual(resolve_timezone(None), (UTC, "UTC", "server"))


class TestQuietHoursConfig(unittest.TestCase):
    def _config(self, **cameras: dict[str, Any]) -> FrigateConfig:
        return FrigateConfig(
            mqtt={"enabled": False},
            notifications={
                "enabled": True,
                "quiet_hours": [{"days": ["mon"], "start": "22:00", "end": "07:00"}],
            },
            cameras={name: _camera(**extra) for name, extra in cameras.items()},
        )

    def test_times_must_be_24_hour_hh_mm(self) -> None:
        for bad in ("7:00", "24:00", "22:60", "10pm", ""):
            with self.subTest(bad=bad):
                with self.assertRaises(ValidationError):
                    QuietHoursWindow(start=bad, end="07:00")
        self.assertEqual(QuietHoursWindow(start="00:00", end="23:59").end, "23:59")

    def test_days_are_deduplicated_in_week_order(self) -> None:
        window = QuietHoursWindow(
            start="22:00", end="07:00", days=["sun", "mon", "mon"]
        )
        self.assertEqual(window.days, ["mon", "sun"])
        with self.assertRaises(ValidationError):
            QuietHoursWindow(start="22:00", end="07:00", days=["monday"])

    def test_camera_inherits_global_windows_unless_it_sets_its_own(self) -> None:
        config = self._config(
            front_door={},
            backyard={
                "notifications": {
                    "quiet_hours": [{"start": "09:00", "end": "17:00"}],
                }
            },
            garage={"notifications": {"quiet_hours": []}},
        )
        front = config.cameras["front_door"].notifications.quiet_hours
        self.assertEqual(
            [(w.days, w.start, w.end) for w in front], [(["mon"], "22:00", "07:00")]
        )
        backyard = config.cameras["backyard"].notifications.quiet_hours
        self.assertEqual(
            [(w.days, w.start, w.end) for w in backyard], [([], "09:00", "17:00")]
        )
        self.assertEqual(config.cameras["garage"].notifications.quiet_hours, [])

    @patch.object(ProfileManager, "_persist_active_profile")
    def test_profile_swaps_the_schedule_and_restores_it(self, _persist) -> None:
        if not os.path.exists(MODEL_CACHE_DIR) and not os.path.islink(MODEL_CACHE_DIR):
            os.makedirs(MODEL_CACHE_DIR)
        config = FrigateConfig(
            mqtt={"enabled": False},
            profiles={"away": {"friendly_name": "Away"}},
            cameras={
                "front_door": _camera(
                    notifications={
                        "enabled": True,
                        "quiet_hours": [{"start": "22:00", "end": "07:00"}],
                    },
                    profiles={"away": {"notifications": {"quiet_hours": []}}},
                )
            },
        )
        updater = MagicMock()
        manager = ProfileManager(config, updater)
        night = _at("2026-01-14 23:00")

        self.assertTrue(in_quiet_hours(config, "front_door", night))
        self.assertIsNone(manager.activate_profile("away"))
        self.assertFalse(in_quiet_hours(config, "front_door", night))
        self.assertTrue(updater.publish_update.called)
        self.assertIsNone(manager.activate_profile(None))
        self.assertTrue(in_quiet_hours(config, "front_door", night))


class TestInQuietHours(unittest.TestCase):
    def setUp(self) -> None:
        self.config = FrigateConfig(
            mqtt={"enabled": False},
            ui={"timezone": "America/New_York"},
            cameras={
                "front_door": _camera(
                    notifications={
                        "enabled": True,
                        "quiet_hours": [{"start": "22:00", "end": "07:00"}],
                    }
                ),
                "garage": _camera(),
            },
        )

    def test_uses_the_ui_timezone(self) -> None:
        # 04:00 UTC is 23:00 in New York, 15:00 UTC is 10:00
        with self.assertLogs(schedule.logger, "DEBUG") as logs:
            self.assertTrue(
                in_quiet_hours(self.config, "front_door", _at("2026-01-15 04:00"))
            )
        self.assertIn("front_door: inside its quiet hours", logs.output[0])
        self.assertFalse(
            in_quiet_hours(self.config, "front_door", _at("2026-01-15 15:00"))
        )

    def test_cameras_without_windows_or_unknown_are_never_quiet(self) -> None:
        night = _at("2026-01-15 04:00")
        self.assertFalse(in_quiet_hours(self.config, "garage", night))
        self.assertFalse(in_quiet_hours(self.config, "missing", night))

    def test_defaults_to_the_current_time(self) -> None:
        self.config.cameras["front_door"].notifications.quiet_hours = [
            _window("00:00", "00:00")
        ]
        self.assertTrue(in_quiet_hours(self.config, "front_door"))


class TestWebPushQuietHours(WebPushTestBase):
    """The publish gate, at NOW: Sunday 2025-06-15 15:06 UTC."""

    def setUp(self) -> None:
        super().setUp()
        config = _config(
            quiet_hours=[{"days": ["sun"], "start": "15:00", "end": "16:00"}]
        )
        config.ui.timezone = "UTC"
        self.client = self.make_client(config)
        self.client.send_alert = MagicMock()
        self.client.send_trigger = MagicMock()
        self.client.send_camera_monitoring = MagicMock()

    def _trigger(self) -> str:
        return json.dumps(
            {
                "camera": "front_door",
                "type": "thumbnail",
                "event_id": "ev1",
                "name": "red_car",
                "score": 0.9,
            }
        )

    def test_review_alerts_are_held_back_inside_the_window(self) -> None:
        self.client.publish("reviews", json.dumps(_review()))
        self.client.send_alert.assert_not_called()

        self.client.config.cameras["front_door"].notifications.quiet_hours = [
            _window("16:00", "17:00")
        ]
        self.client.publish("reviews", json.dumps(_review()))
        self.client.send_alert.assert_called_once()

    def test_triggers_are_held_back_inside_the_window(self) -> None:
        self.client.publish("triggers", self._trigger())
        self.client.send_trigger.assert_not_called()

        self.client.config.cameras["front_door"].notifications.quiet_hours = []
        self.client.publish("triggers", self._trigger())
        self.client.send_trigger.assert_called_once()

    def test_camera_monitoring_is_not_held_back(self) -> None:
        payload = json.dumps({"camera": "front_door", "message": "Camera offline"})
        self.client.publish("camera_monitoring", payload)
        self.client.send_camera_monitoring.assert_called_once()

    def test_ui_timezone_updates_are_applied(self) -> None:
        self.global_sub_cls.return_value.check_for_update.side_effect = [
            ("config/ui", UIConfig(timezone="Asia/Tokyo")),
            (None, None),
        ]
        # 15:06 UTC is 00:06 on Monday in Tokyo, outside the Sunday window
        self.client.publish("reviews", json.dumps(_review()))
        self.assertEqual(self.client.config.ui.timezone, "Asia/Tokyo")
        self.client.send_alert.assert_called_once()

    def test_frozen_clock_is_inside_the_window(self) -> None:
        self.assertEqual(
            dt.datetime.fromtimestamp(NOW, UTC).strftime("%a %H:%M"), "Sun 15:06"
        )


if __name__ == "__main__":
    unittest.main()
