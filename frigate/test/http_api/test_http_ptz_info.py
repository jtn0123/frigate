"""GET /{camera_name}/ptz/info waits for the ONVIF loop without blocking."""

import asyncio
import json
import threading
import unittest
from types import SimpleNamespace

from frigate.api.media import camera_ptz_info


class FakeOnvif:
    """Runs get_camera_info on its own loop and thread, as OnvifController does."""

    def __init__(self, released: threading.Event):
        self.released = released
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    async def get_camera_info(self, camera_name: str) -> dict:
        # A slow camera: the answer arrives only once the API loop releases it.
        # With a blocked API loop that never happens, so give up after 2 s.
        released = await self.loop.run_in_executor(None, self.released.wait, 2)
        return {"name": camera_name, "released": released}

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join()
        self.loop.close()


class TestPtzInfo(unittest.IsolatedAsyncioTestCase):
    async def test_waiting_for_the_camera_leaves_the_api_loop_free(self):
        released = threading.Event()
        onvif = FakeOnvif(released)
        self.addCleanup(onvif.close)
        request = SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=SimpleNamespace(cameras={"ptz_cam": object()}),
                onvif=onvif,
            )
        )

        task = asyncio.create_task(camera_ptz_info(request, "ptz_cam"))
        # Let the handler start. If it blocks the loop, this line only runs
        # after the camera has already timed out.
        await asyncio.sleep(0)
        released.set()
        response = await task

        assert response.status_code == 200
        assert json.loads(response.body) == {"name": "ptz_cam", "released": True}

    async def test_unknown_camera_is_404(self):
        request = SimpleNamespace(
            app=SimpleNamespace(frigate_config=SimpleNamespace(cameras={}))
        )

        response = await camera_ptz_info(request, "missing")

        assert response.status_code == 404
