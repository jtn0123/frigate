"""PTZ control for a camera that was removed at runtime (D58).

Removing a camera pops its config and PTZ metrics while ONVIF requests and
queued autotracker moves can still name it. Those calls must return quietly,
and the normal path must keep working against the metrics it resolved once."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import numpy as np

from frigate.camera import PTZMetrics
from frigate.config import FrigateConfig
from frigate.config.camera.onvif import ZoomingModeEnum
from frigate.ptz.autotrack import PtzAutoTracker
from frigate.ptz.onvif import OnvifController

CAMERA = "ptz_cam"


def _config(zooming: str = "disabled") -> FrigateConfig:
    return FrigateConfig(
        mqtt={"enabled": False},
        cameras={
            CAMERA: {
                "ffmpeg": {
                    "inputs": [
                        {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                    ]
                },
                "detect": {"width": 1920, "height": 1080},
                "zones": {"zone": {"coordinates": "0,0,1,0,1,1,0,1"}},
                "onvif": {
                    "host": "10.0.0.1",
                    "autotracking": {
                        "enabled": True,
                        "required_zones": ["zone"],
                        "zooming": zooming,
                    },
                },
            }
        },
    )


def _controller(zooming: str = "disabled") -> OnvifController:
    """An initialized controller built without __init__, which would start an
    event loop thread and reach out to the camera."""
    controller = OnvifController.__new__(OnvifController)
    controller.config = _config(zooming)
    controller.failed_cams = {}
    ptz = MagicMock()
    for method in ("RelativeMove", "GotoPreset", "AbsoluteMove", "GetStatus"):
        setattr(ptz, method, AsyncMock())
    controller.cams = {
        CAMERA: {
            "onvif": MagicMock(update_xaddrs=AsyncMock()),
            "init": True,
            "active": False,
            "ptz": ptz,
            "features": ["pt", "pt-r-fov", "zoom-a"],
            "presets": {"home": "token_home"},
            "move_request": MagicMock(ProfileToken="profile_1"),
            "relative_move_request": MagicMock(),
            "absolute_move_request": MagicMock(),
            "status_request": MagicMock(),
            "relative_fov_range": {
                "XRange": {"Min": -1.0, "Max": 1.0},
                "YRange": {"Min": -1.0, "Max": 1.0},
            },
            "absolute_zoom_range": {"XRange": {"Min": 0.0, "Max": 10.0}},
        }
    }
    controller.ptz_metrics = {CAMERA: PTZMetrics(autotracker_enabled=True)}
    controller.status_locks = {CAMERA: asyncio.Lock()}
    return controller


def _status(pan_tilt: str, zoom: str | None = None, zoom_x: float = 5.0):
    return SimpleNamespace(
        MoveStatus=SimpleNamespace(PanTilt=pan_tilt, Zoom=zoom),
        Position=SimpleNamespace(Zoom=SimpleNamespace(x=zoom_x)),
    )


class TestOnvifRemovedCamera(unittest.IsolatedAsyncioTestCase):
    async def test_init_for_removed_camera_does_not_contact_it(self):
        controller = _controller()
        controller.config.cameras.pop(CAMERA)

        self.assertFalse(await controller._init_onvif(CAMERA))
        controller.cams[CAMERA]["onvif"].update_xaddrs.assert_not_awaited()

    async def test_moves_without_metrics_do_nothing(self):
        controller = _controller()
        controller.ptz_metrics.pop(CAMERA)
        ptz = controller.cams[CAMERA]["ptz"]

        await controller._move_relative(CAMERA, 0.1, 0.1, 0, 1)
        await controller._move_to_preset(CAMERA, "home")
        await controller._zoom_absolute(CAMERA, 0.5, 1)

        ptz.RelativeMove.assert_not_awaited()
        ptz.GotoPreset.assert_not_awaited()
        ptz.AbsoluteMove.assert_not_awaited()
        self.assertFalse(controller.cams[CAMERA]["active"])

    async def test_camera_info_for_removed_camera_is_empty(self):
        controller = _controller()
        controller.config.cameras.pop(CAMERA)

        self.assertEqual(await controller.get_camera_info(CAMERA), {})

    async def test_status_for_removed_camera_is_not_requested(self):
        for pop in ("metrics", "config"):
            with self.subTest(removed=pop):
                controller = _controller()
                if pop == "metrics":
                    controller.ptz_metrics.pop(CAMERA)
                else:
                    controller.config.cameras.pop(CAMERA)

                await controller.get_camera_status(CAMERA)

                controller.cams[CAMERA]["ptz"].GetStatus.assert_not_awaited()


class TestOnvifMoves(unittest.IsolatedAsyncioTestCase):
    async def test_move_to_preset_resets_the_movement_clock(self):
        controller = _controller()
        metrics = controller.ptz_metrics[CAMERA]
        metrics.start_time.value = 10
        metrics.stop_time.value = 12

        await controller._move_to_preset(CAMERA, "HOME")

        controller.cams[CAMERA]["ptz"].GotoPreset.assert_awaited_once_with(
            {"ProfileToken": "profile_1", "PresetToken": "token_home"}
        )
        self.assertEqual(metrics.start_time.value, 0)
        self.assertEqual(metrics.stop_time.value, 0)
        self.assertFalse(controller.cams[CAMERA]["active"])

    async def test_zoom_absolute_scales_to_the_camera_range(self):
        controller = _controller()
        metrics = controller.ptz_metrics[CAMERA]
        metrics.frame_time.value = 100.0

        await controller._zoom_absolute(CAMERA, 0.5, 1)

        request = controller.cams[CAMERA]["absolute_move_request"]
        self.assertEqual(request.Position, {"Zoom": 5.0})
        self.assertEqual(request.Speed, {"Zoom": 1})
        controller.cams[CAMERA]["ptz"].AbsoluteMove.assert_awaited_once_with(request)
        self.assertEqual(metrics.start_time.value, 100.0)
        self.assertEqual(metrics.stop_time.value, 0)
        self.assertFalse(metrics.motor_stopped.is_set())

    async def test_zoom_absolute_waits_for_an_active_move(self):
        controller = _controller()
        controller.cams[CAMERA]["active"] = True

        await controller._zoom_absolute(CAMERA, 0.5, 1)

        controller.cams[CAMERA]["ptz"].AbsoluteMove.assert_not_awaited()


class TestOnvifCameraStatus(unittest.IsolatedAsyncioTestCase):
    async def test_idle_stops_the_motor_clock(self):
        controller = _controller()
        metrics = controller.ptz_metrics[CAMERA]
        metrics.motor_stopped.clear()
        metrics.frame_time.value = 50.0
        controller.cams[CAMERA]["ptz"].GetStatus.return_value = _status("IDLE")

        await controller.get_camera_status(CAMERA)

        self.assertTrue(metrics.motor_stopped.is_set())
        self.assertEqual(metrics.stop_time.value, 50.0)
        self.assertFalse(controller.cams[CAMERA]["active"])

    async def test_moving_starts_the_motor_clock_and_reads_zoom(self):
        controller = _controller(zooming="absolute")
        metrics = controller.ptz_metrics[CAMERA]
        metrics.frame_time.value = 60.0
        controller.cams[CAMERA]["ptz"].GetStatus.return_value = _status(
            "MOVING", zoom_x=2.5
        )

        await controller.get_camera_status(CAMERA)

        self.assertFalse(metrics.motor_stopped.is_set())
        self.assertEqual(metrics.start_time.value, 60.0)
        self.assertEqual(metrics.stop_time.value, 0)
        self.assertAlmostEqual(metrics.zoom_level.value, 0.25)
        self.assertTrue(controller.cams[CAMERA]["active"])

    async def test_camera_stuck_in_moving_is_given_a_stop_time(self):
        controller = _controller()
        metrics = controller.ptz_metrics[CAMERA]
        metrics.motor_stopped.clear()
        metrics.start_time.value = 10.0
        metrics.frame_time.value = 30.0
        controller.cams[CAMERA]["ptz"].GetStatus.return_value = _status("MOVING")

        with self.assertLogs("frigate.ptz.onvif", "WARNING") as logs:
            await controller.get_camera_status(CAMERA)

        self.assertEqual(metrics.stop_time.value, 30.0)
        self.assertIn("still in ONVIF 'MOVING' status", logs.output[0])


class TestAutotrackerAbsoluteZoomMove(unittest.TestCase):
    def test_pan_waits_for_the_motor_then_zooms(self):
        tracker = PtzAutoTracker.__new__(PtzAutoTracker)
        tracker.config = _config(zooming="absolute")
        autotracking = tracker.config.cameras[CAMERA].onvif.autotracking
        self.assertEqual(autotracking.zooming, ZoomingModeEnum.absolute)
        autotracking.movement_weights = ["0.0"] * 6
        metrics = PTZMetrics(autotracker_enabled=True)
        tracker.ptz_metrics = {CAMERA: metrics}
        tracker.intercept = {CAMERA: 1.0}
        tracker.move_coefficients = {CAMERA: np.array([0.5, 2.0])}
        tracker.move_metrics = {CAMERA: []}
        tracker.stop_event = MagicMock()
        tracker.stop_event.is_set.side_effect = [False, True]

        calls = []

        async def move_relative(camera, pan, tilt, zoom, speed):
            calls.append(("move", pan, tilt, zoom))
            metrics.motor_stopped.clear()

        async def camera_status(camera):
            calls.append(("status",))
            metrics.motor_stopped.set()

        async def zoom_absolute(camera, zoom, speed):
            calls.append(("zoom", zoom))

        tracker.onvif = SimpleNamespace(
            _move_relative=move_relative,
            get_camera_status=camera_status,
            _zoom_absolute=zoom_absolute,
        )

        async def run():
            tracker.move_queues = {CAMERA: asyncio.Queue()}
            tracker.move_queue_locks = {CAMERA: asyncio.Lock()}
            tracker.move_queues[CAMERA].put_nowait((1000.0, 0.2, -0.1, 0.6))
            await tracker._process_move_queue(CAMERA)

        asyncio.run(run())

        # pan/tilt first without zoom, wait for the motor, then zoom absolutely
        self.assertEqual(
            calls,
            [("move", 0.2, -0.1, 0), ("status",), ("zoom", 0.6)],
        )


if __name__ == "__main__":
    unittest.main()
