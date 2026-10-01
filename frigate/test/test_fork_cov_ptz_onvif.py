"""Coverage for the ONVIF PTZ controller (fork D73).

Exercises OnvifController setup, camera (re)initialization, feature detection,
movement commands, status polling and shutdown. ONVIFCamera and the zeep
services are mocked, the loop thread is never started and time is patched.
"""

import asyncio
import concurrent.futures
import unittest
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from frigate.camera import PTZMetrics
from frigate.config import FrigateConfig
from frigate.config.camera.onvif import ZoomingModeEnum
from frigate.config.camera.updater import CameraConfigUpdateEnum
from frigate.ptz import onvif as onvif_module
from frigate.ptz.onvif import OnvifCommandEnum, OnvifController

CAMERA = "ptz_cam"
FOV_URI = "http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov"
GENERIC_PT_URI = "http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace"
GENERIC_ZOOM_URI = "http://www.onvif.org/ver10/tptz/ZoomSpaces/TranslationGenericSpace"


class Z(dict):
    """A zeep-like object that supports both attribute and item access."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as err:
            raise AttributeError(name) from err

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value


def _config(
    autotracking: bool = False,
    zooming: str = "disabled",
    profile: str | None = None,
) -> FrigateConfig:
    onvif: dict[str, Any] = {
        "host": "10.0.0.1",
        "port": 8080,
        "user": "admin",
        "password": "secret",
        "autotracking": {
            "enabled": autotracking,
            "required_zones": ["zone"],
            "zooming": zooming,
        },
    }
    if profile is not None:
        onvif["profile"] = profile

    def camera(**extra: Any) -> dict[str, Any]:
        cam = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
            },
            "detect": {"width": 1920, "height": 1080},
            "zones": {"zone": {"coordinates": "0,0,1,0,1,1,0,1"}},
        }
        cam.update(extra)
        return cam

    return FrigateConfig(
        mqtt={"enabled": False},
        cameras={
            CAMERA: camera(onvif=onvif),
            "off_cam": camera(enabled=False, onvif={"host": "10.0.0.2"}),
            "plain_cam": camera(),
        },
    )


def _ptz_configuration(**overrides: Any) -> Z:
    cfg = Z(
        token="ptz_config_1",
        DefaultContinuousPanTiltVelocitySpace="cont_pt",
        DefaultContinuousZoomVelocitySpace="cont_zoom",
        DefaultRelativePanTiltTranslationSpace="rel_pt",
        DefaultRelativeZoomTranslationSpace="rel_zoom",
        DefaultAbsoluteZoomPositionSpace="abs_zoom",
        DefaultPTZSpeed=Z(PanTilt=Z(x=1, y=1)),
        ZoomLimits=Z(Range=Z(Min=0, Max=1)),
    )
    cfg.update(overrides)
    return cfg


def _profile(profile_id: str = "profile_1", name: Any = "Main", **cfg: Any) -> Z:
    return Z(
        token=profile_id,
        Name=name,
        VideoEncoderConfiguration=Z(Encoding="H264"),
        PTZConfiguration=_ptz_configuration(**cfg),
    )


def _spaces(**overrides: Any) -> Z:
    spaces = Z(
        RelativePanTiltTranslationSpace=[
            Z(URI=GENERIC_PT_URI),
            Z(
                URI=FOV_URI,
                XRange=Z(Min=-2.0, Max=2.0),
                YRange=Z(Min=-1.0, Max=1.0),
            ),
        ],
        RelativeZoomTranslationSpace=[
            Z(URI=GENERIC_ZOOM_URI, XRange=Z(Min=-1.0, Max=1.0))
        ],
        AbsoluteZoomPositionSpace=[Z(URI="abs", XRange=Z(Min=0.0, Max=10.0))],
    )
    spaces.update(overrides)
    return spaces


def _status_with_zoom() -> Z:
    return Z(
        Position=Z(
            PanTilt=Z(x=0.1, y=0.2, space="abs_pt"),
            Zoom=Z(x=0.3, space="abs_zoom"),
        )
    )


def _create_type(name: str) -> Z:
    if name == "RelativeMove":
        return Z(request_type=name, ProfileToken=None, Translation=None, Speed=None)
    return Z(request_type=name)


def _onvif_camera(
    profiles: list | None = None,
    ptz_config: Any = None,
    status: Any = None,
    presets: list | None = None,
    imaging_settings: Any = None,
) -> MagicMock:
    """A fully featured camera; individual calls can be made to fail."""
    onvif = MagicMock()
    onvif.update_xaddrs = AsyncMock()
    media = MagicMock()
    media.xaddr = "http://10.0.0.1/media"
    media.GetProfiles = AsyncMock(
        return_value=profiles if profiles is not None else [_profile()]
    )
    media.GetVideoSources = AsyncMock(return_value=[Z(token="video_source_1")])
    onvif.create_media_service = AsyncMock(return_value=media)
    onvif.get_definition = MagicMock(return_value={"ptz": "definition"})

    ptz = MagicMock()
    ptz.create_type = MagicMock(side_effect=_create_type)
    ptz.GetConfigurationOptions = AsyncMock(
        return_value=ptz_config if ptz_config is not None else Z(Spaces=_spaces())
    )
    ptz.GetStatus = AsyncMock(
        return_value=status if status is not None else _status_with_zoom()
    )
    ptz.GetPresets = AsyncMock(return_value=presets if presets is not None else [])
    onvif.create_ptz_service = AsyncMock(return_value=ptz)

    imaging = MagicMock()
    imaging.GetImagingSettings = AsyncMock(
        return_value=imaging_settings
        if imaging_settings is not None
        else Z(Focus=Z(AutoFocusMode="MANUAL"))
    )
    onvif.create_imaging_service = AsyncMock(return_value=imaging)
    return onvif


def _controller(
    config: FrigateConfig | None = None, onvif: MagicMock | None = None
) -> OnvifController:
    """Build a controller without __init__, which would start the loop thread."""
    config = config or _config()
    controller = OnvifController.__new__(OnvifController)
    controller.config = config
    # same shape as the state _init_single_camera creates
    controller.cams = {
        CAMERA: {
            "onvif": onvif or _onvif_camera(),
            "init": False,
            "active": False,
            "features": [],
            "presets": {},
            "profiles": [],
        }
    }
    controller.failed_cams = {}
    controller.max_retries = 5
    controller.reset_timeout = 900
    controller.camera_configs = {CAMERA: config.cameras[CAMERA]}
    controller.ptz_metrics = {
        CAMERA: PTZMetrics(
            autotracker_enabled=config.cameras[CAMERA].onvif.autotracking.enabled
        )
    }
    controller.status_locks = {}
    return controller


def _ready_controller(features: list[str] | None = None) -> OnvifController:
    """An initialized controller with mocked PTZ and imaging services."""
    controller = _controller()
    ptz = MagicMock()
    for method in (
        "Stop",
        "ContinuousMove",
        "RelativeMove",
        "GotoPreset",
        "AbsoluteMove",
        "GetStatus",
        "GetServiceCapabilities",
    ):
        setattr(ptz, method, AsyncMock())
    imaging = MagicMock()
    imaging.create_type = MagicMock(side_effect=lambda name: Z(request_type=name))
    imaging.Stop = AsyncMock()
    imaging.Move = AsyncMock()
    controller.cams[CAMERA].update(
        {
            "init": True,
            "active": False,
            "ptz": ptz,
            "imaging": imaging,
            "video_source_token": "video_source_1",
            "features": features
            if features is not None
            else ["pt", "zoom", "pt-r", "zoom-r", "zoom-a", "focus", "pt-r-fov"],
            "presets": {"home": "token_home"},
            "profiles": [{"name": "Main", "token": "profile_1"}],
            "move_request": Z(ProfileToken="profile_1"),
            "relative_move_request": Z(
                Translation=Z(PanTilt=Z(x=0, y=0, space=FOV_URI)), Speed=None
            ),
            "absolute_move_request": Z(),
            "status_request": Z(request_type="GetStatus"),
            "service_capabilities_request": Z(request_type="GetServiceCapabilities"),
            "relative_fov_range": {
                "XRange": {"Min": -2.0, "Max": 2.0},
                "YRange": {"Min": -1.0, "Max": 1.0},
            },
            "absolute_zoom_range": {"XRange": {"Min": 0.0, "Max": 10.0}},
        }
    )
    return controller


def _close_coro(coro: Any, _loop: Any) -> MagicMock:
    """Stand-in for run_coroutine_threadsafe that never schedules the coroutine."""
    coro.close()
    return MagicMock()


class TestControllerLifecycle(unittest.TestCase):
    def test_init_tracks_enabled_onvif_cameras_and_schedules_tasks(self) -> None:
        config = _config()
        with (
            patch.object(onvif_module, "threading") as threading_mock,
            patch.object(onvif_module, "CameraConfigUpdateSubscriber") as subscriber,
            patch.object(
                onvif_module.asyncio,
                "run_coroutine_threadsafe",
                side_effect=_close_coro,
            ) as run_threadsafe,
        ):
            controller = OnvifController(config, {})
        self.addCleanup(controller.loop.close)

        self.assertEqual(list(controller.camera_configs), [CAMERA])
        self.assertEqual(list(controller.status_locks), [CAMERA])
        self.assertEqual(controller.max_retries, 5)
        self.assertEqual(controller.reset_timeout, 900)
        threading_mock.Thread.assert_called_once_with(
            target=controller._run_event_loop, daemon=True
        )
        threading_mock.Thread.return_value.start.assert_called_once()
        self.assertEqual(
            subscriber.call_args.args[2],
            [
                CameraConfigUpdateEnum.onvif,
                CameraConfigUpdateEnum.add,
                CameraConfigUpdateEnum.remove,
            ],
        )
        self.assertEqual(run_threadsafe.call_count, 2)
        for call in run_threadsafe.call_args_list:
            self.assertIs(call.args[1], controller.loop)

    def test_close_stops_loop_then_is_idempotent(self) -> None:
        controller = OnvifController.__new__(OnvifController)
        controller.loop = asyncio.new_event_loop()
        self.addCleanup(controller.loop.close)
        controller.config_subscriber = MagicMock()
        controller.loop_thread = MagicMock()

        controller.close()

        controller.config_subscriber.stop.assert_called_once()
        controller.loop_thread.join.assert_called_once()
        # the scheduled callback stops the loop, so run_forever returns
        controller.loop.run_forever()
        self.assertFalse(controller.loop.is_running())

        controller.loop.close()
        with self.assertLogs(onvif_module.logger, "DEBUG") as logs:
            controller.close()
        self.assertIn("already closed", logs.output[0])
        controller.config_subscriber.stop.assert_called_once()

    def test_close_without_loop_is_noop(self) -> None:
        controller = OnvifController.__new__(OnvifController)
        with self.assertLogs(onvif_module.logger, "DEBUG") as logs:
            controller.close()
        self.assertIn("already closed", logs.output[0])

    def test_close_logs_loop_stop_failure(self) -> None:
        controller = OnvifController.__new__(OnvifController)
        controller.loop = MagicMock()
        controller.loop.is_closed.return_value = False
        controller.loop.stop.side_effect = RuntimeError("boom")
        controller.loop.call_soon_threadsafe.side_effect = lambda fn: fn()
        controller.config_subscriber = MagicMock()
        controller.loop_thread = MagicMock()

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            controller.close()

        self.assertIn("Error during loop cleanup", logs.output[0])
        controller.loop_thread.join.assert_called_once()

    def test_run_event_loop_runs_until_stopped(self) -> None:
        controller = OnvifController.__new__(OnvifController)
        controller.loop = asyncio.new_event_loop()
        self.addCleanup(controller.loop.close)
        self.addCleanup(asyncio.set_event_loop, None)
        ran = []
        controller.loop.call_soon(ran.append, True)
        controller.loop.call_soon(controller.loop.stop)

        controller._run_event_loop()

        self.assertEqual(ran, [True])

    def test_run_event_loop_logs_unexpected_termination(self) -> None:
        controller = OnvifController.__new__(OnvifController)
        controller.loop = MagicMock(spec=asyncio.AbstractEventLoop)
        controller.loop.run_forever.side_effect = RuntimeError("died")
        self.addCleanup(asyncio.set_event_loop, None)

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            controller._run_event_loop()

        self.assertIn("terminated unexpectedly", logs.output[0])


class TestHandleCommandSync(unittest.TestCase):
    def _controller(self) -> OnvifController:
        controller = _ready_controller()
        controller.loop = MagicMock()
        return controller

    def test_runs_command_on_loop(self) -> None:
        controller = self._controller()

        def run_now(coro: Any, _loop: Any) -> concurrent.futures.Future:
            future: concurrent.futures.Future = concurrent.futures.Future()
            future.set_result(asyncio.run(coro))
            return future

        with patch.object(
            onvif_module.asyncio, "run_coroutine_threadsafe", side_effect=run_now
        ):
            controller.handle_command(CAMERA, OnvifCommandEnum.preset, "home")

        controller.cams[CAMERA]["ptz"].GotoPreset.assert_awaited_once_with(
            {"ProfileToken": "profile_1", "PresetToken": "token_home"}
        )

    def test_logs_timeout_and_errors(self) -> None:
        cases = (
            (TimeoutError(), "timed out"),
            (RuntimeError("bad"), "Error executing command"),
        )
        for error, message in cases:
            with self.subTest(error=type(error).__name__):
                controller = self._controller()
                future = MagicMock()
                future.result.side_effect = error

                def schedule(coro: Any, _loop: Any, future: Any = future) -> Any:
                    coro.close()
                    return future

                with (
                    patch.object(
                        onvif_module.asyncio,
                        "run_coroutine_threadsafe",
                        side_effect=schedule,
                    ),
                    self.assertLogs(onvif_module.logger, "ERROR") as logs,
                ):
                    controller.handle_command(CAMERA, OnvifCommandEnum.stop)

                future.result.assert_called_once_with(timeout=10)
                self.assertIn(message, logs.output[0])


class TestConfigUpdates(unittest.IsolatedAsyncioTestCase):
    async def test_init_cameras_initializes_each_config(self) -> None:
        controller = _controller()
        controller.camera_configs["other"] = MagicMock()
        controller._init_single_camera = AsyncMock(return_value=True)

        await controller._init_cameras()

        self.assertEqual(
            [c.args[0] for c in controller._init_single_camera.await_args_list],
            [CAMERA, "other"],
        )

    async def test_poll_dispatches_updates_and_survives_errors(self) -> None:
        controller = _controller()
        controller.config_subscriber = MagicMock()
        controller.config_subscriber.check_for_updates.side_effect = [
            {
                "onvif": [CAMERA],
                "add": ["plain_cam", "missing_cam", CAMERA],
                "remove": ["gone_cam"],
            },
            RuntimeError("zmq"),
        ]
        controller._reinit_camera = AsyncMock()
        controller._remove_camera = AsyncMock()
        sleep = AsyncMock(side_effect=[None, None, asyncio.CancelledError()])

        with (
            patch.object(onvif_module.asyncio, "sleep", sleep),
            self.assertLogs(onvif_module.logger, "ERROR") as logs,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await controller._poll_config_updates()

        # only cameras that have an onvif host are set up when added
        self.assertEqual(
            [c.args[0] for c in controller._reinit_camera.await_args_list],
            [CAMERA, CAMERA],
        )
        controller._remove_camera.assert_awaited_once_with("gone_cam")
        self.assertIn("Error checking for ONVIF config updates", logs.output[0])
        sleep.assert_awaited_with(1)

    async def test_close_camera_ignores_close_errors(self) -> None:
        controller = _controller()
        session = controller.cams[CAMERA]["onvif"]
        session.close = AsyncMock(side_effect=RuntimeError("closed"))

        with self.assertLogs(onvif_module.logger, "DEBUG") as logs:
            await controller._close_camera(CAMERA)

        session.close.assert_awaited_once()
        self.assertIn("Error closing ONVIF session", logs.output[-1])

    async def test_reinit_cleans_up_when_camera_removed(self) -> None:
        controller = _controller()
        controller.config.cameras.pop(CAMERA)
        controller.failed_cams[CAMERA] = {"retry_attempts": 1}
        session = controller.cams[CAMERA]["onvif"]
        session.close = AsyncMock()

        await controller._reinit_camera(CAMERA)

        session.close.assert_awaited_once()
        self.assertNotIn(CAMERA, controller.cams)
        self.assertNotIn(CAMERA, controller.camera_configs)
        self.assertNotIn(CAMERA, controller.failed_cams)

    async def test_reinit_creates_new_session(self) -> None:
        controller = _controller()
        old_session = controller.cams[CAMERA]["onvif"]
        old_session.close = AsyncMock()
        controller.failed_cams[CAMERA] = {"retry_attempts": 3}
        controller.camera_configs = {}

        with patch.object(onvif_module, "ONVIFCamera") as camera_cls:
            await controller._reinit_camera(CAMERA)

        old_session.close.assert_awaited_once()
        self.assertIs(controller.cams[CAMERA]["onvif"], camera_cls.return_value)
        self.assertFalse(controller.cams[CAMERA]["init"])
        self.assertIs(
            controller.camera_configs[CAMERA], controller.config.cameras[CAMERA]
        )
        self.assertIsInstance(controller.status_locks[CAMERA], asyncio.Lock)
        self.assertNotIn(CAMERA, controller.failed_cams)


class TestInitSingleCamera(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_camera_is_rejected(self) -> None:
        controller = _controller()

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            self.assertFalse(await controller._init_single_camera("bad\ncam"))

        self.assertIn("'bad\\ncam'", logs.output[0])

    async def test_builds_onvif_camera_from_config(self) -> None:
        controller = _controller()
        controller.cams = {}

        with patch.object(onvif_module, "ONVIFCamera") as camera_cls:
            self.assertTrue(await controller._init_single_camera(CAMERA))

        args = camera_cls.call_args
        self.assertEqual(args.args[:2], ("10.0.0.1", 8080))
        self.assertEqual(str(args.args[2]), "admin")
        self.assertEqual(str(args.args[3]), "secret")
        self.assertTrue(args.kwargs["wsdl_dir"].endswith("wsdl"))
        self.assertFalse(args.kwargs["adjust_time"])
        self.assertTrue(args.kwargs["encrypt"])
        self.assertEqual(
            controller.cams[CAMERA],
            {
                "onvif": camera_cls.return_value,
                "init": False,
                "active": False,
                "features": [],
                "presets": {},
                "profiles": [],
            },
        )

    async def test_records_creation_failure(self) -> None:
        controller = _controller()
        controller.cams = {}

        with (
            patch.object(
                onvif_module, "ONVIFCamera", side_effect=RuntimeError("no route")
            ),
            patch.object(onvif_module, "time") as time_mock,
            self.assertLogs(onvif_module.logger, "ERROR"),
        ):
            time_mock.time.return_value = 1234.0
            self.assertFalse(await controller._init_single_camera(CAMERA))

        self.assertEqual(
            controller.failed_cams[CAMERA],
            {"retry_attempts": 0, "last_error": "no route", "last_attempt": 1234.0},
        )
        self.assertNotIn(CAMERA, controller.cams)


class TestInitOnvifFeatures(unittest.IsolatedAsyncioTestCase):
    async def test_fully_featured_camera(self) -> None:
        presets = [
            Z(Name="Front", token="1"),
            Z(Name=None, token="2"),
            # UTF-8 bytes that zeep decoded as latin-1
            Z(Name="été".encode().decode("latin-1"), token="3"),
            Z(Name="Ü", token="4"),
            Z(Name="日本", token="5"),
        ]
        config = _config(autotracking=True, zooming="relative")
        controller = _controller(config, _onvif_camera(presets=presets))

        self.assertTrue(await controller._init_onvif(CAMERA))

        cam = controller.cams[CAMERA]
        self.assertTrue(cam["init"])
        self.assertEqual(
            cam["features"],
            ["pt", "zoom", "pt-r", "zoom-r", "zoom-a", "focus", "pt-r-fov"],
        )
        self.assertEqual(
            cam["presets"],
            {"front": "1", "preset 2": "2", "été": "3", "ü": "4", "日本": "5"},
        )
        self.assertEqual(cam["profiles"], [{"name": "Main", "token": "profile_1"}])
        self.assertEqual(cam["video_source_token"], "video_source_1")
        self.assertEqual(cam["move_request"].ProfileToken, "profile_1")
        self.assertEqual(cam["absolute_move_request"].ProfileToken, "profile_1")
        self.assertEqual(cam["relative_fov_range"]["URI"], FOV_URI)
        self.assertEqual(cam["relative_zoom_range"]["URI"], GENERIC_ZOOM_URI)
        self.assertEqual(cam["absolute_zoom_range"]["XRange"]["Max"], 10.0)
        self.assertEqual(cam["zoom_limits"], Z(Range=Z(Min=0, Max=1)))

        # the relative request is seeded from the current position
        rel = cam["relative_move_request"]
        self.assertEqual(rel.ProfileToken, "profile_1")
        self.assertEqual(rel.Translation.PanTilt.space, FOV_URI)
        self.assertEqual(rel.Translation.Zoom.space, GENERIC_ZOOM_URI)
        self.assertEqual(rel.Speed, Z(PanTilt=Z(x=1, y=1)))
        self.assertEqual(
            config.cameras[CAMERA].onvif.autotracking.zooming,
            ZoomingModeEnum.relative,
        )

    async def test_zoom_removed_from_relative_request_without_autotracking(
        self,
    ) -> None:
        onvif = _onvif_camera()
        speed = Z(PanTilt=Z(x=1, y=1), Zoom=Z(x=1))
        onvif.create_ptz_service.return_value.create_type.side_effect = lambda name: (
            Z(request_type=name, Translation=None, Speed=speed)
            if name == "RelativeMove"
            else Z(request_type=name)
        )
        controller = _controller(_config(), onvif)

        self.assertTrue(await controller._init_onvif(CAMERA))

        rel = controller.cams[CAMERA]["relative_move_request"]
        self.assertNotIn("Zoom", rel.Translation)
        self.assertEqual(rel.Speed, Z(PanTilt=Z(x=1, y=1)))

    async def test_status_failure_falls_back_to_explicit_translation(self) -> None:
        onvif = _onvif_camera()
        onvif.create_ptz_service.return_value.GetStatus.side_effect = RuntimeError(
            "no status"
        )
        controller = _controller(_config(), onvif)

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            self.assertTrue(await controller._init_onvif(CAMERA))

        self.assertIn("Unable to get status from camera", logs.output[0])
        rel = controller.cams[CAMERA]["relative_move_request"]
        self.assertEqual(
            rel.Translation, {"PanTilt": {"x": 0, "y": 0, "space": FOV_URI}}
        )
        self.assertIn("pt-r-fov", controller.cams[CAMERA]["features"])

    async def test_status_failure_disables_absolute_zooming(self) -> None:
        onvif = _onvif_camera()
        onvif.create_ptz_service.return_value.GetStatus.side_effect = RuntimeError(
            "no status"
        )
        config = _config(autotracking=True, zooming="absolute")
        controller = _controller(config, onvif)

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            self.assertTrue(await controller._init_onvif(CAMERA))

        # Upstream bug: the fallback Translation is a plain dict without a Zoom
        # entry, so setting Translation.Zoom.space raises and zooming is
        # disabled, even in absolute mode, which never uses the relative
        # request and whose absolute zoom range is available here.
        self.assertIn("absolute_zoom_range", controller.cams[CAMERA])
        self.assertEqual(
            config.cameras[CAMERA].onvif.autotracking.zooming,
            ZoomingModeEnum.disabled,
        )
        self.assertTrue(
            any("Relative zoom not supported" in line for line in logs.output)
        )

    async def test_missing_zoom_ranges_disable_zooming(self) -> None:
        cases = (
            ("relative", "RelativeZoomTranslationSpace", "Relative zoom not"),
            ("absolute", "AbsoluteZoomPositionSpace", "Absolute zoom not"),
        )
        for zooming, space, message in cases:
            with self.subTest(zooming=zooming):
                ptz_config = Z(Spaces=_spaces(**{space: []}))
                config = _config(autotracking=True, zooming=zooming)
                controller = _controller(config, _onvif_camera(ptz_config=ptz_config))

                with self.assertLogs(onvif_module.logger, "WARNING") as logs:
                    self.assertTrue(await controller._init_onvif(CAMERA))

                self.assertEqual(
                    config.cameras[CAMERA].onvif.autotracking.zooming,
                    ZoomingModeEnum.disabled,
                )
                self.assertTrue(any(message in line for line in logs.output))

    async def test_no_configuration_options_disables_zooming(self) -> None:
        for zooming, message in (
            ("relative", "Relative zoom range unavailable"),
            ("absolute", "Absolute zoom range unavailable"),
        ):
            with self.subTest(zooming=zooming):
                onvif = _onvif_camera()
                ptz = onvif.create_ptz_service.return_value
                ptz.GetConfigurationOptions.side_effect = RuntimeError("nope")
                config = _config(autotracking=True, zooming=zooming)
                controller = _controller(config, onvif)

                with self.assertLogs(onvif_module.logger, "WARNING") as logs:
                    self.assertTrue(await controller._init_onvif(CAMERA))

                self.assertIn(message, logs.output[-1])
                self.assertEqual(
                    config.cameras[CAMERA].onvif.autotracking.zooming,
                    ZoomingModeEnum.disabled,
                )
                features = controller.cams[CAMERA]["features"]
                self.assertNotIn("pt-r-fov", features)
                self.assertNotIn("relative_move_request", controller.cams[CAMERA])

    async def test_malformed_spaces_skip_fov(self) -> None:
        controller = _controller(_config(), _onvif_camera(ptz_config=Z(Spaces=None)))

        self.assertTrue(await controller._init_onvif(CAMERA))

        cam = controller.cams[CAMERA]
        self.assertNotIn("pt-r-fov", cam["features"])
        self.assertNotIn("relative_zoom_range", cam)
        self.assertNotIn("absolute_zoom_range", cam)

    async def test_minimal_camera_without_focus_or_sources(self) -> None:
        profile = _profile(
            name=None,
            DefaultContinuousZoomVelocitySpace=None,
            DefaultRelativePanTiltTranslationSpace=None,
            DefaultRelativeZoomTranslationSpace=None,
            DefaultAbsoluteZoomPositionSpace=None,
        )
        onvif = _onvif_camera(profiles=[profile])
        media = onvif.create_media_service.return_value
        media.GetVideoSources.side_effect = RuntimeError("no sources")
        ptz = onvif.create_ptz_service.return_value
        ptz.GetPresets.side_effect = RuntimeError("no presets")
        controller = _controller(_config(), onvif)

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            self.assertTrue(await controller._init_onvif(CAMERA))

        cam = controller.cams[CAMERA]
        self.assertEqual(cam["features"], ["pt"])
        self.assertIsNone(cam["video_source_token"])
        self.assertEqual(cam["presets"], {})
        # an unnamed profile is listed by its token
        self.assertEqual(cam["profiles"], [{"name": "profile_1", "token": "profile_1"}])
        self.assertIn("Unable to get presets", logs.output[0])
        onvif.create_imaging_service.return_value.GetImagingSettings.assert_not_awaited()

    async def test_focus_not_reported_without_focus_settings(self) -> None:
        for settings in (Z(Focus=None), RuntimeError("unsupported")):
            with self.subTest(settings=settings):
                onvif = _onvif_camera()
                imaging = onvif.create_imaging_service.return_value
                if isinstance(settings, Exception):
                    imaging.GetImagingSettings.side_effect = settings
                else:
                    imaging.GetImagingSettings.return_value = settings
                controller = _controller(_config(), onvif)

                self.assertTrue(await controller._init_onvif(CAMERA))

                imaging.GetImagingSettings.assert_awaited_once_with(
                    {"VideoSourceToken": "video_source_1"}
                )
                self.assertNotIn("focus", controller.cams[CAMERA]["features"])


class TestInitOnvifProfiles(unittest.IsolatedAsyncioTestCase):
    def _profiles(self) -> list:
        return [
            # skipped: no video encoder, no ptz config, or no velocity spaces
            Z(
                token="no_video",
                Name="NoVideo",
                VideoEncoderConfiguration=None,
                PTZConfiguration=_ptz_configuration(),
            ),
            Z(
                token="no_ptz",
                Name="NoPtz",
                VideoEncoderConfiguration=Z(),
                PTZConfiguration=None,
            ),
            _profile(
                profile_id="no_space",
                name="NoSpace",
                DefaultContinuousPanTiltVelocitySpace=None,
                DefaultContinuousZoomVelocitySpace=None,
            ),
            _profile(profile_id="main_token", name="Main"),
            _profile(profile_id="sub_token", name="Sub"),
        ]

    async def test_profile_selected_by_token_name_or_default(self) -> None:
        for configured, expected in (
            (None, "main_token"),
            ("sub_token", "sub_token"),
            ("Sub", "sub_token"),
        ):
            with self.subTest(configured=configured):
                onvif = _onvif_camera(profiles=self._profiles())
                controller = _controller(_config(profile=configured), onvif)

                self.assertTrue(await controller._init_onvif(CAMERA))

                cam = controller.cams[CAMERA]
                self.assertEqual(cam["move_request"].ProfileToken, expected)
                self.assertEqual(
                    cam["profiles"],
                    [
                        {"name": "Main", "token": "main_token"},
                        {"name": "Sub", "token": "sub_token"},
                    ],
                )

    async def test_unknown_configured_profile_fails(self) -> None:
        onvif = _onvif_camera(profiles=self._profiles())
        controller = _controller(_config(profile="Missing"), onvif)

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            self.assertFalse(await controller._init_onvif(CAMERA))

        self.assertIn("'Missing' not found", logs.output[0])
        self.assertIn("main_token", logs.output[0])
        onvif.create_ptz_service.assert_not_awaited()

    async def test_no_valid_profiles_fails(self) -> None:
        onvif = _onvif_camera(profiles=self._profiles()[:3])
        controller = _controller(_config(), onvif)

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            self.assertFalse(await controller._init_onvif(CAMERA))

        self.assertIn("No appropriate Onvif profiles", logs.output[0])
        self.assertEqual(controller.cams[CAMERA]["profiles"], [])

    async def test_capability_and_profile_errors_fail(self) -> None:
        for failing in ("get_definition", "GetProfiles"):
            with self.subTest(failing=failing):
                onvif = _onvif_camera()
                if failing == "get_definition":
                    onvif.get_definition.side_effect = RuntimeError("not a ptz")
                    message = "Unable to get Onvif capabilities"
                else:
                    media = onvif.create_media_service.return_value
                    media.GetProfiles.side_effect = RuntimeError("timeout")
                    message = "Unable to get Onvif media profiles"
                controller = _controller(_config(), onvif)

                with self.assertLogs(onvif_module.logger, "ERROR") as logs:
                    self.assertFalse(await controller._init_onvif(CAMERA))

                self.assertIn(message, logs.output[0])
                self.assertFalse(controller.cams[CAMERA]["init"])

    async def test_ptz_configuration_read_failure(self) -> None:
        class FlakyProfile:
            token = "flaky"
            Name = "Flaky"
            VideoEncoderConfiguration = Z(Encoding="H264")

            def __init__(self) -> None:
                self.reads = 0

            @property
            def PTZConfiguration(self) -> Z:
                # two reads pass the profile filter, the third one fails
                self.reads += 1
                if self.reads > 2:
                    raise RuntimeError("gone")
                return _ptz_configuration()

        onvif = _onvif_camera(profiles=[FlakyProfile()])
        controller = _controller(_config(), onvif)

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            self.assertFalse(await controller._init_onvif(CAMERA))

        self.assertIn("Invalid Onvif PTZ configuration", logs.output[0])
        onvif.create_ptz_service.assert_not_awaited()


class TestMovementCommands(unittest.IsolatedAsyncioTestCase):
    async def test_stop_also_stops_focus(self) -> None:
        controller = _ready_controller()
        controller.cams[CAMERA]["active"] = True
        cam = controller.cams[CAMERA]

        await controller._stop(CAMERA)

        cam["ptz"].Stop.assert_awaited_once_with(
            {"ProfileToken": "profile_1", "PanTilt": True, "Zoom": True}
        )
        cam["imaging"].Stop.assert_awaited_once_with(
            {"request_type": "Stop", "VideoSourceToken": "video_source_1"}
        )
        self.assertFalse(cam["active"])

    async def test_stop_tolerates_focus_stop_failure(self) -> None:
        controller = _ready_controller()
        cam = controller.cams[CAMERA]
        cam["active"] = True
        cam["imaging"].Stop.side_effect = RuntimeError("no focus")

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            await controller._stop(CAMERA)

        self.assertIn("Failed to stop focus", logs.output[0])
        self.assertFalse(cam["active"])

    async def test_stop_skips_focus_when_unsupported(self) -> None:
        controller = _ready_controller(features=["pt"])

        await controller._stop(CAMERA)

        controller.cams[CAMERA]["ptz"].Stop.assert_awaited_once()
        controller.cams[CAMERA]["imaging"].Stop.assert_not_awaited()

    async def test_move_sets_velocity_per_direction(self) -> None:
        expected = {
            OnvifCommandEnum.move_left: {"PanTilt": {"x": -0.5, "y": 0}},
            OnvifCommandEnum.move_right: {"PanTilt": {"x": 0.5, "y": 0}},
            OnvifCommandEnum.move_up: {"PanTilt": {"x": 0, "y": 0.5}},
            OnvifCommandEnum.move_down: {"PanTilt": {"x": 0, "y": -0.5}},
        }
        for command, velocity in expected.items():
            with self.subTest(command=command):
                controller = _ready_controller()
                cam = controller.cams[CAMERA]

                await controller._move(CAMERA, command)

                cam["ptz"].ContinuousMove.assert_awaited_once()
                request = cam["ptz"].ContinuousMove.await_args.args[0]
                self.assertEqual(request.Velocity, velocity)
                self.assertTrue(cam["active"])

    async def test_move_stops_active_action_first(self) -> None:
        controller = _ready_controller()
        controller.cams[CAMERA]["active"] = True

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            await controller._move(CAMERA, OnvifCommandEnum.move_left)

        self.assertIn("already performing an action, stopping", logs.output[0])
        controller.cams[CAMERA]["ptz"].Stop.assert_awaited_once()
        controller.cams[CAMERA]["ptz"].ContinuousMove.assert_awaited_once()

    async def test_move_unsupported_and_failed(self) -> None:
        controller = _ready_controller(features=["zoom"])
        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller._move(CAMERA, OnvifCommandEnum.move_up)
        self.assertIn("does not support ONVIF pan/tilt", logs.output[0])
        controller.cams[CAMERA]["ptz"].ContinuousMove.assert_not_awaited()

        controller = _ready_controller()
        controller.cams[CAMERA]["ptz"].ContinuousMove.side_effect = RuntimeError("x")
        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            await controller._move(CAMERA, OnvifCommandEnum.move_up)
        self.assertIn("sending move request", logs.output[0])

    async def test_move_relative_with_zoom(self) -> None:
        controller = _ready_controller()
        cam = controller.cams[CAMERA]
        sent = []
        cam["ptz"].RelativeMove.side_effect = lambda req: sent.append(
            (
                req.Translation.PanTilt.x,
                req.Translation.PanTilt.y,
                dict(req["Translation"]["Zoom"]),
                dict(req.Speed),
            )
        )

        await controller._move_relative(CAMERA, 0.5, -1.0, 0.3, 0.8)

        pan, tilt, zoom, speed = sent[0]
        self.assertAlmostEqual(pan, 1.0)
        self.assertAlmostEqual(tilt, -1.0)
        self.assertEqual(zoom, {"x": 0.3})
        self.assertEqual(speed, {"PanTilt": {"x": 0.8, "y": 0.8}, "Zoom": {"x": 0.8}})
        request = cam["relative_move_request"]
        self.assertEqual(request.Translation.PanTilt.x, 0)
        self.assertEqual(request.Translation.PanTilt.y, 0)
        self.assertNotIn("Zoom", request.Translation)
        self.assertFalse(cam["active"])

    async def test_move_relative_unsupported_or_busy(self) -> None:
        controller = _ready_controller(features=["pt"])
        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller._move_relative(CAMERA, 0.1, 0.1, 0, 1)
        self.assertIn("does not support ONVIF RelativeMove", logs.output[0])

        controller = _ready_controller()
        controller.cams[CAMERA]["active"] = True
        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            await controller._move_relative(CAMERA, 0.1, 0.1, 0, 1)
        self.assertIn("not moving", logs.output[0])
        controller.cams[CAMERA]["ptz"].RelativeMove.assert_not_awaited()

    async def test_invalid_preset_is_rejected(self) -> None:
        controller = _ready_controller()

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller._move_to_preset(CAMERA, "Garage")

        self.assertIn("garage is not a valid preset", logs.output[0])
        controller.cams[CAMERA]["ptz"].GotoPreset.assert_not_awaited()

    async def test_zoom_commands(self) -> None:
        for command, velocity in (
            (OnvifCommandEnum.zoom_in, {"Zoom": {"x": 0.5}}),
            (OnvifCommandEnum.zoom_out, {"Zoom": {"x": -0.5}}),
        ):
            with self.subTest(command=command):
                controller = _ready_controller()
                controller.cams[CAMERA]["active"] = True

                with self.assertLogs(onvif_module.logger, "WARNING"):
                    await controller._zoom(CAMERA, command)

                ptz = controller.cams[CAMERA]["ptz"]
                ptz.Stop.assert_awaited_once()
                self.assertEqual(
                    ptz.ContinuousMove.await_args.args[0].Velocity, velocity
                )
                self.assertTrue(controller.cams[CAMERA]["active"])

    async def test_zoom_unsupported(self) -> None:
        controller = _ready_controller(features=["pt"])

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller._zoom(CAMERA, OnvifCommandEnum.zoom_in)
            await controller._zoom_absolute(CAMERA, 0.5, 1)

        self.assertIn("does not support ONVIF zooming", logs.output[0])
        self.assertIn("does not support ONVIF AbsoluteMove", logs.output[1])
        controller.cams[CAMERA]["ptz"].ContinuousMove.assert_not_awaited()
        controller.cams[CAMERA]["ptz"].AbsoluteMove.assert_not_awaited()

    async def test_focus_commands(self) -> None:
        for command, speed in (
            (OnvifCommandEnum.focus_in, 0.5),
            (OnvifCommandEnum.focus_out, -0.5),
        ):
            with self.subTest(command=command):
                controller = _ready_controller()
                cam = controller.cams[CAMERA]
                cam["active"] = True

                with self.assertLogs(onvif_module.logger, "WARNING"):
                    await controller._focus(CAMERA, command)

                cam["ptz"].Stop.assert_awaited_once()
                request = cam["imaging"].Move.await_args.args[0]
                self.assertEqual(request.VideoSourceToken, "video_source_1")
                self.assertEqual(request.Focus, {"Continuous": {"Speed": speed}})
                self.assertTrue(cam["active"])

    async def test_focus_failure_and_unsupported(self) -> None:
        controller = _ready_controller()
        cam = controller.cams[CAMERA]
        cam["imaging"].Move.side_effect = RuntimeError("busy")
        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            await controller._focus(CAMERA, OnvifCommandEnum.focus_in)
        self.assertIn("sending focus request", logs.output[0])
        self.assertFalse(cam["active"])

        controller = _ready_controller()
        controller.cams[CAMERA]["imaging"] = None
        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller._focus(CAMERA, OnvifCommandEnum.focus_in)
        self.assertIn("does not support ONVIF continuous focus", logs.output[0])
        self.assertFalse(controller.cams[CAMERA]["active"])


class TestHandleCommandAsync(unittest.IsolatedAsyncioTestCase):
    def _controller(self) -> OnvifController:
        controller = _ready_controller()
        for name in (
            "_stop",
            "_move_to_preset",
            "_move_relative",
            "_zoom",
            "_focus",
            "_move",
        ):
            setattr(controller, name, AsyncMock())
        return controller

    async def test_dispatches_each_command(self) -> None:
        controller = self._controller()

        await controller.handle_command_async(CAMERA, OnvifCommandEnum.init)
        await controller.handle_command_async(CAMERA, OnvifCommandEnum.stop)
        await controller.handle_command_async(CAMERA, OnvifCommandEnum.preset, "home")
        await controller.handle_command_async(
            CAMERA, OnvifCommandEnum.move_relative, "move_0.25_-0.5"
        )
        await controller.handle_command_async(
            CAMERA, OnvifCommandEnum.move_relative, "move_0.25_-0.5_0.75"
        )
        await controller.handle_command_async(CAMERA, OnvifCommandEnum.zoom_out)
        await controller.handle_command_async(CAMERA, OnvifCommandEnum.focus_in)
        await controller.handle_command_async(CAMERA, OnvifCommandEnum.move_down)

        controller._stop.assert_awaited_once_with(CAMERA)
        controller._move_to_preset.assert_awaited_once_with(CAMERA, "home")
        self.assertEqual(
            [c.args for c in controller._move_relative.await_args_list],
            [(CAMERA, 0.25, -0.5, 0.0, 1), (CAMERA, 0.25, -0.5, 0.75, 1)],
        )
        controller._zoom.assert_awaited_once_with(CAMERA, OnvifCommandEnum.zoom_out)
        controller._focus.assert_awaited_once_with(CAMERA, OnvifCommandEnum.focus_in)
        controller._move.assert_awaited_once_with(CAMERA, OnvifCommandEnum.move_down)

    async def test_rejects_bad_input_and_logs_failures(self) -> None:
        controller = self._controller()

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller.handle_command_async("nope", OnvifCommandEnum.stop)
            await controller.handle_command_async(
                CAMERA, OnvifCommandEnum.move_relative, "move_1"
            )
            controller._stop.side_effect = RuntimeError("fault")
            await controller.handle_command_async(CAMERA, OnvifCommandEnum.stop)

        self.assertIn("ONVIF is not configured for nope", logs.output[0])
        self.assertIn("Invalid move_relative params: move_1", logs.output[1])
        self.assertIn("Unable to handle onvif command: fault", logs.output[2])
        controller._move_relative.assert_not_awaited()

    async def test_initializes_before_command(self) -> None:
        controller = self._controller()
        controller.cams[CAMERA]["init"] = False
        controller._init_onvif = AsyncMock(side_effect=[False, True])

        await controller.handle_command_async(CAMERA, OnvifCommandEnum.stop)
        controller._stop.assert_not_awaited()

        await controller.handle_command_async(CAMERA, OnvifCommandEnum.stop)
        controller._stop.assert_awaited_once_with(CAMERA)


class TestGetCameraInfo(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_or_unconfigured_camera_is_empty(self) -> None:
        controller = _controller()

        self.assertEqual(await controller.get_camera_info("off_cam"), {})
        self.assertEqual(await controller.get_camera_info("plain_cam"), {})

    async def test_initialized_camera_returns_details(self) -> None:
        controller = _ready_controller(features=["pt"])

        info = await controller.get_camera_info(CAMERA)

        self.assertEqual(
            info,
            {
                "name": CAMERA,
                "features": ["pt"],
                "presets": ["home"],
                "profiles": [{"name": "Main", "token": "profile_1"}],
            },
        )

    async def test_session_creation_failure_is_empty(self) -> None:
        controller = _controller()
        controller.cams = {}

        with (
            patch.object(onvif_module, "ONVIFCamera", side_effect=RuntimeError("x")),
            self.assertLogs(onvif_module.logger, "ERROR"),
        ):
            self.assertEqual(await controller.get_camera_info(CAMERA), {})

        self.assertIn(CAMERA, controller.failed_cams)

    async def test_retry_count_resets_after_timeout_and_succeeds(self) -> None:
        controller = _controller()
        controller.cams = {}
        controller.failed_cams[CAMERA] = {"retry_attempts": 5, "last_attempt": 100.0}

        async def init(camera_name: str) -> bool:
            controller.cams[camera_name].update(
                {"init": True, "features": ["pt"], "presets": {"home": "1"}}
            )
            return True

        controller._init_onvif = AsyncMock(side_effect=init)

        with (
            patch.object(onvif_module, "ONVIFCamera"),
            patch.object(onvif_module, "time") as time_mock,
        ):
            time_mock.time.return_value = 100.0 + 901
            info = await controller.get_camera_info(CAMERA)

        self.assertEqual(
            info, {"name": CAMERA, "features": ["pt"], "presets": ["home"]}
        )
        self.assertNotIn(CAMERA, controller.failed_cams)

    async def test_failed_init_does_not_count_a_retry(self) -> None:
        controller = _controller()
        controller._init_onvif = AsyncMock(return_value=False)

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            self.assertEqual(await controller.get_camera_info(CAMERA), {})

        self.assertIn("ONVIF initialization failed", logs.output[0])
        # Upstream bug: a False return (the usual result for an unreachable
        # camera, since _init_onvif catches connection errors) never increments
        # retry_attempts, so max_retries only limits raised exceptions.
        self.assertEqual(controller.failed_cams, {})

    async def test_too_many_attempts_reports_remaining_time(self) -> None:
        for elapsed, suffix in ((300.0, "10 minutes"), (840.0, "1 minute")):
            with self.subTest(elapsed=elapsed):
                controller = _controller()
                controller._init_onvif = AsyncMock()
                controller.failed_cams[CAMERA] = {
                    "retry_attempts": 5,
                    "last_attempt": 1000.0,
                }

                with (
                    patch.object(onvif_module, "time") as time_mock,
                    self.assertLogs(onvif_module.logger, "ERROR") as logs,
                ):
                    time_mock.time.return_value = 1000.0 + elapsed
                    self.assertEqual(await controller.get_camera_info(CAMERA), {})

                controller._init_onvif.assert_not_awaited()
                self.assertTrue(logs.output[0].endswith(f"retry in {suffix}"))


class TestServiceCapabilities(unittest.IsolatedAsyncioTestCase):
    async def test_unconfigured_camera(self) -> None:
        controller = _ready_controller()

        with self.assertLogs(onvif_module.logger, "ERROR"):
            self.assertEqual(await controller.get_service_capabilities("nope"), {})

    async def test_returns_move_status_after_init(self) -> None:
        controller = _ready_controller()
        controller.cams[CAMERA]["init"] = False
        controller._init_onvif = AsyncMock(return_value=True)
        ptz = controller.cams[CAMERA]["ptz"]

        class Capabilities:
            def __init__(self) -> None:
                self.EFlip = False
                self.MoveStatus = True

        ptz.GetServiceCapabilities.return_value = Capabilities()

        self.assertTrue(await controller.get_service_capabilities(CAMERA))
        controller._init_onvif.assert_awaited_once_with(CAMERA)
        ptz.GetServiceCapabilities.assert_awaited_once_with(
            controller.cams[CAMERA]["service_capabilities_request"]
        )

    async def test_unsupported_method_returns_false(self) -> None:
        controller = _ready_controller()
        controller.cams[CAMERA][
            "ptz"
        ].GetServiceCapabilities.side_effect = RuntimeError("fault")

        with self.assertLogs(onvif_module.logger, "WARNING") as logs:
            self.assertFalse(await controller.get_service_capabilities(CAMERA))

        self.assertIn("GetServiceCapabilities", logs.output[0])


class TestCameraStatus(unittest.IsolatedAsyncioTestCase):
    def _controller(self) -> OnvifController:
        controller = _ready_controller()
        controller.status_locks = {CAMERA: asyncio.Lock(), "nope": asyncio.Lock()}
        return controller

    async def test_unconfigured_camera(self) -> None:
        controller = self._controller()

        with self.assertLogs(onvif_module.logger, "ERROR") as logs:
            await controller.get_camera_status("nope")

        self.assertIn("ONVIF is not configured for nope", logs.output[0])

    async def test_init_failure_skips_status(self) -> None:
        controller = self._controller()
        controller.cams[CAMERA]["init"] = False
        controller._init_onvif = AsyncMock(return_value=False)

        await controller.get_camera_status(CAMERA)

        controller.cams[CAMERA]["ptz"].GetStatus.assert_not_awaited()

    async def test_unsupported_status_warns(self) -> None:
        for name, configure in (
            ("raises", {"side_effect": RuntimeError("fault")}),
            ("unknown", {"return_value": Z(MoveStatus="UNKNOWN")}),
            ("missing", {"return_value": Z(MoveStatus=None)}),
        ):
            with self.subTest(case=name):
                controller = self._controller()
                controller.cams[CAMERA]["ptz"].GetStatus.configure_mock(**configure)

                with self.assertLogs(onvif_module.logger, "WARNING") as logs:
                    await controller.get_camera_status(CAMERA)

                self.assertIn("does not support the ONVIF GetStatus", logs.output[0])
                self.assertFalse(controller.cams[CAMERA]["active"])

    async def test_plain_move_status_string_is_accepted(self) -> None:
        controller = self._controller()
        metrics = controller.ptz_metrics[CAMERA]
        metrics.motor_stopped.set()
        metrics.frame_time.value = 42.0
        controller.cams[CAMERA]["ptz"].GetStatus.return_value = Z(MoveStatus="MOVING")

        await controller.get_camera_status(CAMERA)

        self.assertTrue(controller.cams[CAMERA]["active"])
        self.assertFalse(metrics.motor_stopped.is_set())
        self.assertEqual(metrics.start_time.value, 42.0)

    async def test_zoom_moving_keeps_camera_active(self) -> None:
        controller = self._controller()
        metrics = controller.ptz_metrics[CAMERA]
        metrics.motor_stopped.clear()
        metrics.start_time.value = 40.0
        metrics.frame_time.value = 45.0
        controller.cams[CAMERA]["ptz"].GetStatus.return_value = Z(
            MoveStatus=Z(PanTilt="IDLE", Zoom="MOVING")
        )

        await controller.get_camera_status(CAMERA)

        self.assertTrue(controller.cams[CAMERA]["active"])
        # already moving, so the clock is not restarted
        self.assertEqual(metrics.start_time.value, 40.0)
        self.assertEqual(metrics.stop_time.value, 0)


if __name__ == "__main__":
    unittest.main()
