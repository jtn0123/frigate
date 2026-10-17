"""Slow image and log operations must not pause unrelated API requests."""

import asyncio
import io
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import numpy as np
from fastapi import FastAPI

from frigate.api import app as app_api
from frigate.api import media


class TestApiResponsiveness(unittest.IsolatedAsyncioTestCase):
    def app(self):
        app = FastAPI()
        app.add_api_route("/frame/{camera_name}/latest.{extension}", media.latest_frame)
        app.add_api_route("/logs/{service}", app_api.logs)

        @app.get("/heartbeat")
        async def heartbeat():
            return {"ready": True}

        return app

    async def check_heartbeat(self, app, slow_path):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            started = time.monotonic()
            slow = asyncio.create_task(client.get(slow_path))
            await asyncio.sleep(0.05)
            heartbeat = await client.get("/heartbeat")
            latency = time.monotonic() - started
            response = await slow
        self.assertEqual(heartbeat.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertLess(latency, 0.25)
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
            time.sleep(0.4)
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
            time.sleep(0.4)
            return io.StringIO("a log entry\n")

        with patch.object(app_api, "open", side_effect=slow_open, create=True):
            response = await self.check_heartbeat(
                self.app(), "/logs/frigate?download=1"
            )
        self.assertEqual(response.json(), "a log entry\n")
