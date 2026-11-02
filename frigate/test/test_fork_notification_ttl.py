"""The notifications ttl option (B43, upstream #24829)."""

from typing import Any
from unittest.mock import MagicMock

from pydantic import ValidationError

from frigate.config.camera.notification import (
    NOTIFICATION_TTL_SECONDS,
    NotificationConfig,
    NotificationTTLEnum,
)
from frigate.test.test_fork_cov_comms_webpush import (
    WebPushTestBase,
    _config,
    _review,
)


class TestNotificationTTLConfig(WebPushTestBase):
    def test_defaults_to_immediate(self) -> None:
        self.assertEqual(NotificationConfig().ttl, NotificationTTLEnum.immediate)
        self.assertEqual(NOTIFICATION_TTL_SECONDS[NotificationTTLEnum.immediate], 0)

    def test_rejects_raw_seconds(self) -> None:
        with self.assertRaises(ValidationError):
            NotificationConfig(ttl=30)


class TestAlertTTL(WebPushTestBase):
    def _client(self, **notif: Any):
        client = self.make_client(_config(**notif))
        client.send_push_notification = MagicMock()
        client.cleanup_registrations = MagicMock()
        return client

    @staticmethod
    def _ttls(client) -> list[int]:
        return [c.kwargs["ttl"] for c in client.send_push_notification.call_args_list]

    def test_active_alert_is_immediate_by_default(self) -> None:
        client = self._client()
        client.send_alert(_review())
        self.assertEqual(set(self._ttls(client)), {0})

    def test_reliable_retries_an_active_alert(self) -> None:
        client = self._client(ttl="reliable")
        client.send_alert(_review())
        self.assertEqual(set(self._ttls(client)), {30})

    def test_ended_alert_keeps_an_hour_either_way(self) -> None:
        client = self._client(ttl="reliable")
        client.send_alert(_review(state="end", objects=["person"]))
        self.assertEqual(set(self._ttls(client)), {3600})
