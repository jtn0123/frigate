"""Coverage for the web push notification client (fork D73).

Builds WebPushClient with a real FrigateConfig, an in-memory User table, and
patched threads, VAPID keys, push senders and config subscribers, then drives
publish, the alert/trigger/monitoring senders, the notification worker and
the registration bookkeeping directly.
"""

import datetime
import json
import queue
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

from playhouse.sqlite_ext import SqliteExtDatabase

from frigate.comms import webpush as webpush_module
from frigate.comms.webpush import PushNotification, WebPushClient
from frigate.config import FrigateConfig
from frigate.config.auth import AuthConfig
from frigate.const import BASE_DIR
from frigate.models import User

NOW = 1_750_000_000.0
ENDPOINT_A = "https://push.example.com/send/aaa"
ENDPOINT_B = "https://fcm.example.net/send/bbb"


def _camera(**extra: Any) -> dict[str, Any]:
    camera: dict[str, Any] = {
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
        },
        "detect": {"height": 720, "width": 1280, "fps": 5},
    }
    camera.update(extra)
    return camera


def _config(email: str | None = "me@example.com", **notif: Any) -> FrigateConfig:
    notifications: dict[str, Any] = {"enabled": True}
    if email is not None:
        notifications["email"] = email
    notifications.update(notif)
    return FrigateConfig(
        **{
            "mqtt": {"enabled": False},
            "notifications": notifications,
            "auth": {"roles": {"front_only": ["front_door"]}},
            "cameras": {
                "front_door": _camera(
                    notifications={"enabled": True},
                    zones={
                        "porch": {
                            "coordinates": "0,0,100,0,100,100,0,100",
                            "friendly_name": "The Porch",
                        }
                    },
                    semantic_search={
                        "triggers": {
                            "red_car": {
                                "type": "thumbnail",
                                "data": "abc",
                                "actions": ["notification"],
                            },
                            "quiet": {
                                "type": "description",
                                "data": "x",
                                "actions": ["sub_label"],
                            },
                        }
                    },
                ),
                "back_yard": _camera(
                    friendly_name="Back Yard Cam",
                    notifications={"enabled": True},
                ),
                "garage": _camera(notifications={"enabled": False}),
            },
        }
    )


class _FrozenDatetime(datetime.datetime):
    """datetime subclass whose now() is pinned to a settable timestamp."""

    current = NOW

    @classmethod
    def now(cls, tz: Any = None) -> "_FrozenDatetime":
        return cls.fromtimestamp(cls.current, tz)


class WebPushTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.db = SqliteExtDatabase(":memory:")
        self.db.bind([User])
        self.db.connect()
        self.db.create_tables([User])
        User.create(
            username="admin",
            role="admin",
            password_hash="x",
            notification_tokens=[
                {"endpoint": ENDPOINT_A, "keys": {"p256dh": "k", "auth": "a"}},
                {"endpoint": ENDPOINT_B, "keys": {"p256dh": "k", "auth": "a"}},
            ],
        )
        User.create(
            username="viewer",
            role="front_only",
            password_hash="x",
            notification_tokens=[
                {"endpoint": ENDPOINT_A + "2", "keys": {"p256dh": "k", "auth": "a"}}
            ],
        )

        _FrozenDatetime.current = NOW
        patches = [
            patch.object(webpush_module.threading, "Thread"),
            patch.object(webpush_module, "Vapid01"),
            patch.object(webpush_module, "WebPusher", side_effect=self._pusher),
            patch.object(webpush_module, "ConfigSubscriber"),
            patch.object(webpush_module, "CameraConfigUpdateSubscriber"),
            patch.object(webpush_module.datetime, "datetime", _FrozenDatetime),
        ]
        mocks = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)
        self.thread_cls, self.vapid_cls = mocks[0], mocks[1]
        self.global_sub_cls, self.camera_sub_cls = mocks[3], mocks[4]
        self.vapid_cls.from_file.return_value.sign.side_effect = lambda claim: {
            "Authorization": f"vapid {claim['aud']}"
        }
        self.global_sub_cls.return_value.check_for_update.return_value = (None, None)
        self.camera_sub_cls.return_value.check_for_updates.return_value = {}

    def tearDown(self) -> None:
        self.db.drop_tables([User])
        self.db.close()

    @staticmethod
    def _pusher(sub: dict[str, Any]) -> MagicMock:
        pusher = MagicMock()
        pusher.subscription_info = sub
        pusher.send.return_value = MagicMock(status_code=201)
        return pusher

    def make_client(self, config: FrigateConfig | None = None) -> WebPushClient:
        stop_event = MagicMock()
        return WebPushClient(config or _config(), stop_event)


class TestConstruction(WebPushTestBase):
    def test_init_loads_pushers_and_user_cameras(self) -> None:
        client = self.make_client()

        self.assertEqual(self.thread_cls.call_count, 2)
        self.assertEqual(self.thread_cls.return_value.start.call_count, 2)
        self.assertEqual(len(client.web_pushers["admin"]), 2)
        self.assertEqual(len(client.web_pushers["viewer"]), 1)
        self.assertEqual(
            client.user_cameras["admin"], {"front_door", "back_yard", "garage"}
        )
        self.assertEqual(client.user_cameras["viewer"], {"front_door"})
        self.assertEqual(
            client.suspended_cameras, {"front_door": 0, "back_yard": 0, "garage": 0}
        )
        client.subscribe(MagicMock())

    def test_init_warns_without_email(self) -> None:
        with self.assertLogs(webpush_module.logger, "WARNING") as logs:
            self.make_client(_config(email=None))
        self.assertIn("Email must be provided", logs.output[0])

    def test_stop_joins_notification_thread(self) -> None:
        client = self.make_client()
        client.stop()
        client.notification_thread.join.assert_called_once()

    def test_user_camera_access_unknown_user(self) -> None:
        client = self.make_client()
        self.assertFalse(client._user_has_camera_access("ghost", "front_door"))
        self.assertTrue(client._user_has_camera_access("viewer", "front_door"))
        self.assertFalse(client._user_has_camera_access("viewer", "back_yard"))


class TestRegistrations(WebPushTestBase):
    def test_check_registrations_signs_each_push_origin_once(self) -> None:
        client = self.make_client()
        client.check_registrations()

        self.assertEqual(
            set(client.claim_headers),
            {"https://push.example.com", "https://fcm.example.net"},
        )
        sign = self.vapid_cls.from_file.return_value.sign
        self.assertEqual(sign.call_count, 2)
        claim = sign.call_args_list[0].args[0]
        self.assertEqual(claim["sub"], "mailto:me@example.com")
        self.assertEqual(claim["exp"], int(NOW + 3600))

        # still valid: no new signatures
        client.check_registrations()
        self.assertEqual(sign.call_count, 2)

        # after the refresh deadline passes the claims are signed again
        _FrozenDatetime.current = NOW + 7200
        client.check_registrations()
        self.assertEqual(sign.call_count, 4)

    def test_cleanup_registrations_drops_expired_tokens(self) -> None:
        client = self.make_client()
        client.expired_subs = {"admin": [ENDPOINT_A]}

        with self.assertLogs(webpush_module.logger, "INFO") as logs:
            client.cleanup_registrations()

        tokens = User.get_by_id("admin").notification_tokens
        self.assertEqual([t["endpoint"] for t in tokens], [ENDPOINT_B])
        self.assertEqual(len(client.web_pushers["admin"]), 1)
        self.assertEqual(client.expired_subs, {})
        self.assertIn(
            "Cleaned up 1 notification subscriptions for admin", logs.output[0]
        )

    def test_cleanup_registrations_noop(self) -> None:
        client = self.make_client()
        client.cleanup_registrations()
        self.assertEqual(len(User.get_by_id("admin").notification_tokens), 2)


class TestSuspension(WebPushTestBase):
    def test_suspend_and_unsuspend(self) -> None:
        client = self.make_client()
        client.suspend_notifications("front_door", 10)
        self.assertEqual(client.suspended_cameras["front_door"], int(NOW + 600))
        self.assertTrue(client.is_camera_suspended("front_door"))

        client.unsuspend_notifications("front_door")
        self.assertFalse(client.is_camera_suspended("front_door"))

    def test_process_suspensions_loop_clears_expired(self) -> None:
        client = self.make_client()
        broadcaster = MagicMock()
        client.set_suspension_broadcaster(broadcaster)
        client.suspended_cameras["back_yard"] = int(NOW - 5)
        client.stop_event.wait.side_effect = [False, True]

        client._process_suspensions()

        self.assertEqual(client.suspended_cameras["back_yard"], 0)
        broadcaster.assert_called_once_with(
            "back_yard/notifications/suspended", "0", True
        )


def _review(
    state: str = "new",
    camera: str = "front_door",
    severity: str = "alert",
    objects: list[str] | None = None,
    zones: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
    before: dict[str, Any] | None = None,
) -> dict[str, Any]:
    after = {
        "id": "rev1",
        "camera": camera,
        "severity": severity,
        "thumb_path": f"{BASE_DIR}/clips/review/thumb-rev1.webp",
        "data": {
            "objects": objects if objects is not None else ["person", "car-verified"],
            "sub_labels": ["Bob"],
            "zones": zones if zones is not None else ["porch", "side_gate"],
            "metadata": metadata,
        },
    }
    return {"type": state, "before": before or after, "after": after}


class TestSendAlert(WebPushTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.client = self.make_client()
        self.client.send_push_notification = MagicMock()
        self.client.cleanup_registrations = MagicMock()

    def _sent(self) -> list[dict[str, Any]]:
        return [c.kwargs for c in self.client.send_push_notification.call_args_list]

    def test_new_alert_formats_title_and_respects_camera_access(self) -> None:
        self.client.send_alert(_review())

        sent = self._sent()
        self.assertEqual({s["user"] for s in sent}, {"admin", "viewer"})
        first = sent[0]
        # labels come from a set, so their order in the title is not stable
        labels, zones = first["title"].split(" detected in ")
        self.assertEqual(set(labels.split(", ")), {"Bob", "Person"})
        self.assertEqual(zones, "The Porch, Side Gate")
        self.assertEqual(first["message"], "Detected on Front Door")
        self.assertEqual(first["direct_url"], "/#front_door")
        self.assertEqual(first["image"], "/clips/review/thumb-rev1.webp")
        self.assertEqual(first["ttl"], 0)
        self.assertEqual(self.client.last_notification_time, NOW)
        self.client.cleanup_registrations.assert_called_once()

    def test_alert_skips_users_without_access(self) -> None:
        self.client.send_alert(_review(camera="back_yard", zones=[]))
        sent = self._sent()
        self.assertEqual([s["user"] for s in sent], ["admin"])
        self.assertEqual(sent[0]["message"], "Detected on Back Yard Cam")

    def test_end_alert_links_to_review(self) -> None:
        self.client.send_alert(_review(state="end", objects=["person"]))
        first = self._sent()[0]
        self.assertIn(" was detected in ", first["title"])
        self.assertEqual(first["direct_url"], "/review?id=rev1")
        self.assertEqual(first["ttl"], 3600)

    def test_genai_alert_threat_levels(self) -> None:
        cases = [
            (0, "Someone at door", None, "Someone at door", "Detected on Front Door"),
            (1, "Lurker", "short", "Needs Review: Lurker", "short"),
            (
                2,
                "Break in",
                None,
                "Security Concern: Break in",
                "Detected on Front Door",
            ),
        ]
        for level, base, summary, title, message in cases:
            with self.subTest(level=level):
                self.client.send_push_notification.reset_mock()
                self.client.last_notification_time = 0
                self.client.last_camera_notification_time["front_door"] = 0
                metadata: dict[str, Any] = {
                    "title": base,
                    "potential_threat_level": level,
                }
                if summary:
                    metadata["shortSummary"] = summary
                self.client.send_alert(_review(state="genai", metadata=metadata))
                first = self._sent()[0]
                self.assertEqual(first["title"], title)
                self.assertEqual(first["message"], message)

    def test_ignores_detections_and_missing_email(self) -> None:
        self.client.send_alert(_review(severity="detection"))
        self.client.config.notifications.email = None
        self.client.send_alert(_review())
        self.assertEqual(self._sent(), [])

    def test_update_without_changes_is_skipped(self) -> None:
        self.client.send_alert(_review(state="update"))
        self.assertEqual(self._sent(), [])
        # the cooldown timestamps are untouched because nothing was sent
        self.assertEqual(self.client.last_notification_time, 0)

    def test_global_and_camera_cooldowns(self) -> None:
        self.client.config.notifications.cooldown = 60
        self.client.last_notification_time = NOW - 10
        self.client.send_alert(_review())
        self.assertEqual(self._sent(), [])

        self.client.config.notifications.cooldown = 0
        self.client.config.cameras["front_door"].notifications.cooldown = 60
        self.client.last_camera_notification_time["front_door"] = NOW - 10
        self.client.send_alert(_review())
        self.assertEqual(self._sent(), [])


class TestSendTriggerAndMonitoring(WebPushTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.client = self.make_client()
        self.client.send_push_notification = MagicMock()
        self.client.cleanup_registrations = MagicMock()

    def test_send_trigger(self) -> None:
        self.client.send_trigger(
            {
                "camera": "front_door",
                "type": "thumbnail",
                "event_id": "ev1",
                "name": "red_car",
                "score": 0.912,
            }
        )
        calls = self.client.send_push_notification.call_args_list
        self.assertEqual({c.kwargs["user"] for c in calls}, {"admin", "viewer"})
        kwargs = calls[0].kwargs
        self.assertEqual(kwargs["title"], "red car triggered on Front Door")
        self.assertEqual(
            kwargs["message"],
            "Thumbnail trigger fired for Front Door with score 0.91",
        )
        self.assertEqual(kwargs["image"], "clips/triggers/front_door/ev1.webp")
        self.assertEqual(kwargs["direct_url"], "/explore?event_id=ev1")

    def test_send_trigger_access_email_and_cooldown(self) -> None:
        payload = {
            "camera": "back_yard",
            "type": "description",
            "event_id": "ev2",
            "name": "x",
            "score": 0.5,
        }
        self.client.send_trigger(payload)
        calls = self.client.send_push_notification.call_args_list
        self.assertEqual([c.kwargs["user"] for c in calls], ["admin"])

        # camera cooldown now applies
        self.client.config.cameras["back_yard"].notifications.cooldown = 30
        self.client.send_trigger(payload)
        self.assertEqual(self.client.send_push_notification.call_count, 1)

        self.client.config.notifications.email = None
        self.client.send_trigger(payload)
        self.assertEqual(self.client.send_push_notification.call_count, 1)

    def test_send_camera_monitoring_truncates_long_text(self) -> None:
        self.client.send_camera_monitoring(
            {"camera": "back_yard", "reasoning": "z" * 250}
        )
        kwargs = self.client.send_push_notification.call_args.kwargs
        self.assertEqual(kwargs["title"], "Back Yard Cam: Monitoring Alert")
        self.assertEqual(len(kwargs["message"]), 200)
        self.assertTrue(kwargs["message"].endswith("..."))

    def test_send_notification_test(self) -> None:
        self.client.send_notification_test()
        calls = self.client.send_push_notification.call_args_list
        self.assertEqual({c.kwargs["user"] for c in calls}, {"admin", "viewer"})
        self.assertEqual(calls[0].kwargs["notification_type"], "test")

        self.client.send_push_notification.reset_mock()
        self.client.config.notifications.email = None
        self.client.send_notification_test()
        self.client.send_push_notification.assert_not_called()


class TestPublish(WebPushTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.client = self.make_client()
        for name in (
            "send_alert",
            "send_trigger",
            "send_camera_monitoring",
            "send_notification_test",
        ):
            setattr(self.client, name, MagicMock())

    def test_reviews_routing(self) -> None:
        self.client.publish("reviews", json.dumps(_review()))
        self.client.send_alert.assert_called_once()

        self.client.publish("reviews", json.dumps(_review(camera="garage")))
        self.client.publish("reviews", json.dumps(_review(camera="removed")))
        self.client.suspend_notifications("front_door", 5)
        self.client.publish("reviews", json.dumps(_review()))
        self.assertEqual(self.client.send_alert.call_count, 1)

    def test_triggers_routing(self) -> None:
        def trigger(name: str, camera: str = "front_door") -> str:
            return json.dumps({"camera": camera, "name": name})

        self.client.publish("triggers", trigger("red_car"))
        self.client.send_trigger.assert_called_once()

        # trigger without the notification action, unknown trigger, disabled camera
        self.client.publish("triggers", trigger("quiet"))
        self.client.publish("triggers", trigger("unknown"))
        self.client.publish("triggers", trigger("red_car", camera="garage"))
        self.client.suspend_notifications("front_door", 5)
        self.client.publish("triggers", trigger("red_car"))
        self.assertEqual(self.client.send_trigger.call_count, 1)

    def test_camera_monitoring_routing(self) -> None:
        payload = json.dumps({"camera": "back_yard", "message": "hi"})
        self.client.publish("camera_monitoring", payload)
        self.client.send_camera_monitoring.assert_called_once()

        self.client.publish(
            "camera_monitoring", json.dumps({"camera": "garage", "message": "x"})
        )
        self.client.suspend_notifications("back_yard", 5)
        self.client.publish("camera_monitoring", payload)
        self.assertEqual(self.client.send_camera_monitoring.call_count, 1)

    def test_notification_test_routing(self) -> None:
        self.client.publish("notification_test", "")
        self.client.send_notification_test.assert_called_once()

        self.client.config.notifications.enabled = False
        for camera in self.client.config.cameras.values():
            camera.notifications.enabled = False
        self.client.publish("notification_test", "")
        self.assertEqual(self.client.send_notification_test.call_count, 1)

    def test_applies_global_config_updates(self) -> None:
        new_notifications = self.client.config.notifications.model_copy(
            update={"cooldown": 42}
        )
        new_auth = AuthConfig(roles={"front_only": ["back_yard"]})
        self.global_sub_cls.return_value.check_for_update.side_effect = [
            ("config/notifications", new_notifications),
            ("config/notifications", None),
            ("config/auth", new_auth),
            ("config/auth", "not-an-auth-config"),
            (None, None),
        ]

        self.client.publish("other", "")

        self.assertEqual(self.client.config.notifications.cooldown, 42)
        self.assertIs(self.client.config.auth, new_auth)
        self.assertEqual(self.client.user_cameras["viewer"], {"back_yard"})

    def test_added_camera_gets_bookkeeping(self) -> None:
        self.camera_sub_cls.return_value.check_for_updates.return_value = {
            "add": ["new_cam"]
        }
        self.client.publish("other", "")
        self.assertEqual(self.client.suspended_cameras["new_cam"], 0)
        self.assertEqual(self.client.last_camera_notification_time["new_cam"], 0)


class TestNotificationWorker(WebPushTestBase):
    def test_process_notifications_sends_and_tracks_expired(self) -> None:
        client = self.make_client()
        admin_a, admin_b = client.web_pushers["admin"]
        admin_a.send.return_value = MagicMock(status_code=410)
        admin_b.send.return_value = MagicMock(status_code=500)

        client.send_push_notification(
            "admin",
            {"after": {"id": "rev9"}},
            "Title",
            "Message",
            direct_url="/x",
            image="img",
            notification_type="alert",
            ttl=60,
        )
        client.send_push_notification("viewer", {}, "T2", "M2")
        # a notification for an unknown user raises KeyError inside the loop
        # and is logged rather than killing the worker
        client.notification_queue.put(
            PushNotification(user="ghost", payload={}, title="", message="")
        )

        stop_flags = iter([False, False, False, False, True])
        client.stop_event.is_set.side_effect = lambda: next(stop_flags)
        real_get = client.notification_queue.get

        def get(timeout: float) -> PushNotification:
            try:
                return real_get(block=False)
            except queue.Empty:
                raise

        with (
            patch.object(client.notification_queue, "get", side_effect=get),
            self.assertLogs(webpush_module.logger, "DEBUG") as logs,
        ):
            client._process_notifications()

        kwargs = admin_a.send.call_args.kwargs
        self.assertEqual(kwargs["headers"]["urgency"], "high")
        self.assertEqual(
            kwargs["headers"]["Authorization"], "vapid https://push.example.com"
        )
        self.assertEqual(kwargs["ttl"], 60)
        data = json.loads(kwargs["data"])
        self.assertEqual(data["id"], "rev9")
        self.assertEqual(data["direct_url"], "/x")
        self.assertEqual(client.expired_subs, {"admin": [ENDPOINT_A]})
        client.web_pushers["viewer"][0].send.assert_called_once()
        output = "\n".join(logs.output)
        self.assertIn("Failed to send notification to admin :: 500", output)
        self.assertIn("Error processing notification", output)


if __name__ == "__main__":
    unittest.main()
