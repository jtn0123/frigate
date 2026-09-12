"""The replay watchdog belongs to the API application's lifetime."""

import asyncio
import unittest
from unittest.mock import MagicMock, patch

from frigate.api.fastapi_app import create_fastapi_app
from frigate.config import FrigateConfig


class TestReplayWatchdogLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_cancels_and_awaits_the_watchdog(self):
        started = asyncio.Event()
        stopped = asyncio.Event()
        captured = []

        async def watchdog(*_args):
            captured.append(asyncio.current_task())
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        config = FrigateConfig(
            mqtt={"enabled": False}, auth={"enabled": False}, cameras={}
        )
        app = create_fastapi_app(
            config,
            MagicMock(),
            None,
            None,
            None,
            None,
            None,
            None,
            MagicMock(),
            MagicMock(),
        )
        with patch("frigate.api.fastapi_app.debug_replay_auto_stop_watchdog", watchdog):
            try:
                async with app.router.lifespan_context(app):
                    await asyncio.wait_for(started.wait(), timeout=1)
                    self.assertFalse(captured[0].done())
                self.assertTrue(stopped.is_set())
                self.assertTrue(captured[0].done())
            finally:
                for task in captured:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*captured, return_exceptions=True)
