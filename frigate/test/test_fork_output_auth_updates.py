"""Tests for the output process's websocket wiring and auth updates (E33).

Role edits publish an AuthConfig on config/auth, and the jsmpeg streams check
camera access against the output process's own copy of the config, so the
process must apply each one. The user endpoints publish None on the same topic.
"""

import multiprocessing as mp
import unittest
from unittest.mock import MagicMock, patch

from frigate.comms.ws import OriginCheckedWebSocketApplication, WebSocket
from frigate.config import AuthConfig, FrigateConfig
from frigate.output.output import OutputProcess


def _config() -> FrigateConfig:
    return FrigateConfig(
        mqtt={"enabled": False},
        auth={"roles": {"limited_user": ["front"]}},
        cameras={
            "front": {
                "ffmpeg": {
                    "inputs": [
                        {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                    ]
                },
                "detect": {"height": 720, "width": 1280, "fps": 5},
            },
        },
    )


class TestOutputProcessAuthUpdates(unittest.TestCase):
    def _run_one_iteration(self, auth_updates: list[tuple]):
        """Run the output loop once with the given config/auth messages."""
        config = _config()
        stop_event = mp.Event()
        process = OutputProcess(config, stop_event)

        auth_subscriber = MagicMock()
        auth_subscriber.check_for_update.side_effect = [*auth_updates, (None, None)]
        birdseye_subscriber = MagicMock()
        birdseye_subscriber.check_for_update.return_value = (None, None)
        subscribers = {
            "config/auth": auth_subscriber,
            "config/birdseye": birdseye_subscriber,
        }

        def detection_update(timeout):
            # end the loop after its first pass, and leave nothing to drain
            stop_event.set()
            return None

        detections = MagicMock()
        detections.check_for_update.side_effect = detection_update

        with (
            patch.object(process, "pre_run_setup"),
            patch.object(process, "add_camera"),
            patch("frigate.output.output.make_server") as make_server,
            patch("frigate.output.output.move_preview_frames"),
            patch(
                "frigate.output.output.ConfigSubscriber",
                side_effect=lambda topic, exact: subscribers[topic],
            ),
            patch("frigate.output.output.CameraConfigUpdateSubscriber"),
            patch("frigate.output.output.DetectionSubscriber", return_value=detections),
            patch("frigate.output.output.SharedMemoryFrameManager"),
        ):
            process.run()

        return process, make_server, auth_subscriber

    def test_role_edit_replaces_auth_config(self):
        edited = AuthConfig(roles={"limited_user": ["back"]})

        process, _, auth_subscriber = self._run_one_iteration([("config/auth", edited)])

        self.assertIs(process.config.auth, edited)
        self.assertEqual(process.config.auth.roles["limited_user"], ["back"])
        auth_subscriber.stop.assert_called_once()

    def test_user_endpoint_notification_keeps_auth_config(self):
        process, _, _ = self._run_one_iteration([("config/auth", None)])

        self.assertEqual(process.config.auth.roles["limited_user"], ["front"])

    def test_every_queued_update_is_applied_in_one_pass(self):
        first = AuthConfig(roles={"limited_user": ["back"]})
        last = AuthConfig(roles={"limited_user": ["front", "back"]})

        process, _, auth_subscriber = self._run_one_iteration(
            [("config/auth", first), ("config/auth", None), ("config/auth", last)]
        )

        self.assertIs(process.config.auth, last)
        # three updates and the empty read that ends the drain, in one pass
        self.assertEqual(auth_subscriber.check_for_update.call_count, 4)

    def test_websocket_server_checks_handshake_origin(self):
        _, make_server, _ = self._run_one_iteration([])

        app = make_server.call_args.kwargs["app"]
        self.assertIsInstance(app, OriginCheckedWebSocketApplication)
        self.assertIs(app.handler_cls, WebSocket)
        self.assertEqual(make_server.call_args.args, ("127.0.0.1", 8082))


if __name__ == "__main__":
    unittest.main(verbosity=2)
