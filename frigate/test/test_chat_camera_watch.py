"""Tests for the start_camera_watch and stop_camera_watch chat tools."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from frigate.api.chat import (
    _execute_start_camera_watch,
    _execute_stop_camera_watch,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _request(username: str, role: str) -> SimpleNamespace:
    return SimpleNamespace(
        headers={"remote-user": username, "remote-role": role},
        app=SimpleNamespace(
            frigate_config=SimpleNamespace(cameras={"front_door": object()}),
            genai_manager=SimpleNamespace(
                chat_client=SimpleNamespace(supports_vision=True)
            ),
            detected_frames_processor=None,
            dispatcher=None,
        ),
    )


class TestStartCameraWatchTool(unittest.TestCase):
    def test_job_records_the_requesting_user(self):
        start = MagicMock(return_value="job1")
        with (
            patch("frigate.api.chat.require_camera_access", AsyncMock()),
            patch("frigate.api.chat.start_vlm_watch_job", start),
        ):
            result = _run(
                _execute_start_camera_watch(
                    _request("alice", "viewer"),
                    {"camera": "front_door", "condition": "a car arrives"},
                )
            )

        self.assertTrue(result["success"])
        self.assertEqual(start.call_args.kwargs.get("username"), "alice")


class TestStopCameraWatchTool(unittest.TestCase):
    def _stop(self, username: str, role: str) -> tuple[dict, MagicMock]:
        stop = MagicMock(return_value=True)
        with (
            patch(
                "frigate.api.chat.get_vlm_watch_job",
                return_value=SimpleNamespace(username="alice"),
            ),
            patch("frigate.api.chat.stop_vlm_watch_job", stop),
        ):
            result = _execute_stop_camera_watch(_request(username, role))
        return result, stop

    def test_other_user_cannot_cancel_the_job(self):
        result, stop = self._stop("bob", "viewer")

        self.assertFalse(result["success"])
        stop.assert_not_called()

    def test_owner_can_cancel_the_job(self):
        result, stop = self._stop("alice", "viewer")

        self.assertTrue(result["success"])
        stop.assert_called_once()

    def test_admin_can_cancel_any_job(self):
        result, stop = self._stop("root", "admin")

        self.assertTrue(result["success"])
        stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
