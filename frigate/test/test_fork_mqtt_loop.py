"""Tests for the selector based Paho network loop (B34, upstream #24573)."""

import fcntl
import resource
import selectors
import socket
import unittest
from unittest.mock import MagicMock, patch

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion, _ConnectionState

from frigate.comms.mqtt import MqttClient
from frigate.fork.mqtt_loop import use_selector_loop


def _client() -> mqtt.Client:
    client = mqtt.Client(CallbackAPIVersion.VERSION2, client_id="loop-test")
    use_selector_loop(client)
    return client


class TestSelectorLoop(unittest.TestCase):
    def setUp(self) -> None:
        self.sock, self.peer = socket.socketpair()
        self.addCleanup(self.sock.close)
        self.addCleanup(self.peer.close)
        self.sock.setblocking(False)
        self.peer.settimeout(1)

    def _connect(self, client: mqtt.Client, sock: socket.socket) -> None:
        client._sock = sock
        self.peer.sendall(b"\x20\x02\x00\x00")  # CONNACK
        self.assertEqual(client.loop(0.1), mqtt.MQTT_ERR_SUCCESS)
        self.assertTrue(client.is_connected())

    def test_loop_does_not_use_select(self) -> None:
        """select() raising ValueError is what a descriptor >= 1024 does."""
        client = _client()
        received: list[bytes] = []
        client.on_message = lambda _c, _u, message: received.append(message.payload)

        with patch(
            "paho.mqtt.client.select.select",
            side_effect=ValueError("filedescriptor out of range in select()"),
        ):
            self._connect(client, self.sock)
            payload = b"\x00\x0adiagnosticincoming"
            self.peer.sendall(b"\x30" + bytes([len(payload)]) + payload)
            self.assertEqual(client.loop(0.1), mqtt.MQTT_ERR_SUCCESS)

        self.assertEqual(received, [b"incoming"])

    def test_high_fd_handles_connack_suback_publish_and_puback(self) -> None:
        if selectors.DefaultSelector is selectors.SelectSelector:
            self.skipTest("This platform has no selector supporting high socket FDs")
        original_limit = resource.getrlimit(resource.RLIMIT_NOFILE)
        soft, hard = original_limit
        if soft <= 1024:
            if hard != resource.RLIM_INFINITY and hard <= 1024:
                self.skipTest("The hard file descriptor limit is too low")
            new_soft = 2048 if hard == resource.RLIM_INFINITY else min(2048, hard)
            resource.setrlimit(resource.RLIMIT_NOFILE, (new_soft, hard))
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, original_limit)

        fd = fcntl.fcntl(self.sock.fileno(), fcntl.F_DUPFD, 1024)
        with socket.socket(fileno=fd) as high_sock:
            high_sock.setblocking(False)
            self.assertGreaterEqual(high_sock.fileno(), 1024)
            client = _client()
            subscribed: list[int] = []
            client.on_subscribe = lambda *args: subscribed.append(args[2])
            self._connect(client, high_sock)

            result, mid = client.subscribe("diagnostic", qos=1)
            self.assertEqual(result, mqtt.MQTT_ERR_SUCCESS)
            self.peer.recv(1024)
            self.peer.sendall(b"\x90\x03" + mid.to_bytes(2, "big") + b"\x01")
            self.assertEqual(client.loop(0.1), mqtt.MQTT_ERR_SUCCESS)
            self.assertEqual(subscribed, [mid])

            info = client.publish("diagnostic", b"outgoing", qos=1)
            self.peer.recv(1024)
            self.peer.sendall(b"\x40\x02" + info.mid.to_bytes(2, "big"))
            self.assertEqual(client.loop(0.1), mqtt.MQTT_ERR_SUCCESS)
            self.assertTrue(info.is_published())

    def test_wake_pair_sends_a_queued_publish(self) -> None:
        """loop_start() publishes only queue the packet and poke the wake pair."""
        client = _client()
        self._connect(client, self.sock)
        # pretend a loop_start() thread owns the socket, so publish() only queues
        client._thread = MagicMock()

        client.publish("diagnostic", b"queued", qos=0)
        self.assertTrue(client.want_write())

        # want_write() is checked before the wait, so only the wake pair can
        # tell this loop pass about the publish
        with patch.object(client, "want_write", return_value=False):
            self.assertEqual(client.loop(1.0), mqtt.MQTT_ERR_SUCCESS)

        self.assertIn(b"queued", self.peer.recv(1024))

    def test_closed_socket_reports_connection_lost(self) -> None:
        client = _client()
        client._sock = None
        client._state = _ConnectionState.MQTT_CS_CONNECTED
        self.assertEqual(client._loop(0), mqtt.MQTT_ERR_CONN_LOST)
        self.assertEqual(client._state, _ConnectionState.MQTT_CS_CONNECTION_LOST)

        client._state = _ConnectionState.MQTT_CS_DISCONNECTING
        self.assertEqual(client._loop(0), mqtt.MQTT_ERR_CONN_LOST)
        self.assertEqual(client._state, _ConnectionState.MQTT_CS_DISCONNECTING)

    def test_selector_error_reports_connection_lost(self) -> None:
        client = _client()
        client._sock = self.sock
        client._state = _ConnectionState.MQTT_CS_CONNECTED
        with patch(
            "frigate.fork.mqtt_loop.selectors.DefaultSelector",
            side_effect=OSError("bad descriptor"),
        ):
            self.assertEqual(client._loop(0), mqtt.MQTT_ERR_CONN_LOST)
        self.assertEqual(client._state, _ConnectionState.MQTT_CS_CONNECTION_LOST)

    def test_negative_timeout_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _client()._loop(-1)

    def test_tls_buffer_is_read_without_waiting(self) -> None:
        client = _client()
        tls_sock = MagicMock()
        tls_sock.fileno.return_value = self.sock.fileno()
        tls_sock.pending.return_value = 1
        client._sock = tls_sock
        with (
            patch("frigate.fork.mqtt_loop.selectors.DefaultSelector") as selector,
            patch.object(client, "loop_read", return_value=0) as loop_read,
            patch.object(client, "loop_misc", return_value=0),
        ):
            selector.return_value.__enter__.return_value.select.return_value = []
            self.assertEqual(client._loop(1), mqtt.MQTT_ERR_SUCCESS)
            selector.return_value.__enter__.return_value.select.assert_called_once_with(
                0.0
            )
        loop_read.assert_called_once()

    def test_read_failure_skips_write_and_keepalive(self) -> None:
        client = _client()
        client._sock = self.sock
        self.peer.sendall(b"ready")
        with (
            patch.object(client, "want_write", return_value=True),
            patch.object(client, "loop_read", return_value=mqtt.MQTT_ERR_CONN_LOST),
            patch.object(client, "loop_write") as loop_write,
            patch.object(client, "loop_misc") as loop_misc,
        ):
            self.assertEqual(client._loop(0), mqtt.MQTT_ERR_CONN_LOST)
        loop_write.assert_not_called()
        loop_misc.assert_not_called()

    def test_write_failure_skips_keepalive(self) -> None:
        client = _client()
        client._sock = self.sock
        with (
            patch.object(client, "want_write", return_value=True),
            patch.object(client, "loop_write", return_value=mqtt.MQTT_ERR_CONN_LOST),
            patch.object(client, "loop_misc") as loop_misc,
        ):
            self.assertEqual(client._loop(0), mqtt.MQTT_ERR_CONN_LOST)
        loop_misc.assert_not_called()


class TestMqttClientUsesSelectorLoop(unittest.TestCase):
    def test_start_installs_the_selector_loop(self) -> None:
        config = MagicMock()
        config.cameras = {}
        config.mqtt.client_id = "frigate"
        config.mqtt.topic_prefix = "frigate"
        config.mqtt.user = None
        config.mqtt.tls_ca_certs = None
        config.mqtt.tls_insecure = None

        with (
            patch("frigate.comms.mqtt.mqtt.Client") as client_cls,
            patch("frigate.comms.mqtt.use_selector_loop") as use_loop,
        ):
            MqttClient(config).subscribe(MagicMock())

        use_loop.assert_called_once_with(client_cls.return_value)


if __name__ == "__main__":
    unittest.main()
