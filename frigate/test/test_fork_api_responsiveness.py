"""Slow image and log operations must not pause unrelated API requests."""

import asyncio
import io
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import numpy as np
from fastapi import FastAPI

from frigate.api import app as app_api
from frigate.api import media

# Only a blocked event loop waits this out, so the test fails instead of hanging
# there. A busy machine answers the heartbeat long before it.
HOLD_TIMEOUT = 30


class TestApiResponsiveness(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.released_by_heartbeat = None

    def app(self):
        app = FastAPI()
        app.add_api_route("/frame/{camera_name}/latest.{extension}", media.latest_frame)
        app.add_api_route("/logs/{service}", app_api.logs)

        @app.get("/heartbeat")
        async def heartbeat():
            return {"ready": True}

        return app

    def hold(self):
        """Stand in for slow work that lasts until the heartbeat is answered.

        In a worker thread, the event loop answers the heartbeat during the wait.
        On the event loop itself, nothing else runs until the wait times out.
        """
        self.entered.set()
        self.released_by_heartbeat = self.release.wait(HOLD_TIMEOUT)

    async def check_heartbeat(self, app, slow_path):
        # The order of events is checked, not their timing, so a slow or busy
        # machine (the local CI runs Docker gates side by side) cannot fail it.
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            slow = asyncio.create_task(client.get(slow_path))
            # ask for the heartbeat only once the slow work is under way
            await asyncio.to_thread(self.entered.wait, HOLD_TIMEOUT)
            heartbeat = await client.get("/heartbeat")
            self.release.set()
            response = await slow
        self.assertEqual(heartbeat.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            self.released_by_heartbeat,
            "the slow work held the event loop, so the heartbeat waited for it",
        )
        return response

    async def test_latest_image_work_does_not_block_the_event_loop(self):
        app = self.app()
        app.frigate_config = SimpleNamespace(
            cameras={
                "front": SimpleNamespace(ffmpeg=SimpleNamespace(retry_interval=10))
            }
        )
        frame = np.zeros((64, 64, 3), np.uint8)

        def slow_frame(*args):
            self.hold()
            return frame

        app.detected_frames_processor = Mock()
        app.detected_frames_processor.get_current_frame.side_effect = slow_frame
        app.detected_frames_processor.get_current_frame_time.side_effect = lambda *_: (
            time.time()
        )
        response = await self.check_heartbeat(app, "/frame/front/latest.jpg")
        self.assertEqual(response.headers["content-type"], "image/jpeg")

    async def test_log_download_does_not_block_the_event_loop(self):
        def slow_open(*args, **kwargs):
            self.hold()
            return io.StringIO("a log entry\n")

        with patch.object(app_api, "open", side_effect=slow_open, create=True):
            response = await self.check_heartbeat(
                self.app(), "/logs/frigate?download=1"
            )
        self.assertEqual(response.json(), "a log entry\n")
