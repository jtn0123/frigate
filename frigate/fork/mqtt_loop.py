"""Drive Paho's network loop with selectors instead of select().

Paho 2.1's `Client._loop` waits on `select.select()`, which raises
`ValueError` for a socket file descriptor of 1024 or higher. Paho turns that
into `MQTT_ERR_CONN_LOST`, so `loop_forever` reconnects, gets another high
descriptor and loses it again. A busy Frigate process (many cameras, pipes and
shared memory segments) can reach that range, which leaves MQTT reconnecting
forever. Upstream fixed this in its own MQTT worker (#24573); this fork still
uses Paho's `loop_start()` thread, so the same wait is replaced on the client.
"""

import selectors
import types
from typing import Any

import paho.mqtt.client as mqtt
from paho.mqtt.enums import MQTTErrorCode, _ConnectionState

_CLOSING_STATES = (
    _ConnectionState.MQTT_CS_DISCONNECTING,
    _ConnectionState.MQTT_CS_DISCONNECTED,
)


def _connection_lost(client: mqtt.Client) -> MQTTErrorCode:
    """Mark the connection lost unless it is closing, as Paho does."""
    if client._state not in _CLOSING_STATES:
        client._state = _ConnectionState.MQTT_CS_CONNECTION_LOST
    return MQTTErrorCode.MQTT_ERR_CONN_LOST


def _selector_loop(self: mqtt.Client, timeout: float = 1.0) -> MQTTErrorCode:
    """`Client._loop` from Paho 2.1 with the wait done by a selector."""
    if timeout < 0.0:
        raise ValueError("Invalid timeout.")

    sock: Any = self._sock
    if sock is None:
        # disconnect() closed the socket, so stop loop_forever like Paho does
        return _connection_lost(self)

    events = selectors.EVENT_READ
    if self.want_write():
        events |= selectors.EVENT_WRITE

    # TLS can have decrypted bytes buffered even when the socket is not ready
    pending_bytes = sock.pending() if hasattr(sock, "pending") else 0
    wake = self._sockpairR

    try:
        with selectors.DefaultSelector() as selector:
            selector.register(sock, events)
            if wake is not None:
                selector.register(wake, selectors.EVENT_READ)
            # kqueue reports reading and writing as separate entries
            ready: dict[Any, int] = {}
            for key, mask in selector.select(0.0 if pending_bytes > 0 else timeout):
                ready[key.fileobj] = ready.get(key.fileobj, 0) | mask
    except (OSError, ValueError):
        # a closed or invalid socket, the same outcome as Paho's select() errors
        return _connection_lost(self)

    sock_events = ready.get(sock, 0)

    if sock_events & selectors.EVENT_READ or pending_bytes > 0:
        rc = self.loop_read()
        if rc or self._sock is None:
            return rc

    if wake is not None and wake in ready:
        # publish() wrote to the wake pair, so try to send even though the
        # write was not requested when the wait started
        sock_events |= selectors.EVENT_WRITE
        try:
            wake.recv(10000)
        except BlockingIOError:
            pass

    if sock_events & selectors.EVENT_WRITE:
        rc = self.loop_write()
        if rc or self._sock is None:
            return rc

    return self.loop_misc()


def use_selector_loop(client: mqtt.Client) -> None:
    """Make `client`'s network loop work with any socket file descriptor."""
    client._loop = types.MethodType(_selector_loop, client)  # type: ignore[method-assign]
