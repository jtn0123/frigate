"""Coverage for the PTZ autotracker (fork D73).

Exercises the motion estimator, the autotracker thread loop, setup and
calibration, the move queue, the velocity and zoom math, and the object
tracking state machine. ONVIF, shared memory, norfair, the event loop
handoff and the clock are all mocked; no threads are started.
"""

import asyncio
import copy
import functools
import unittest
from collections import deque
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np

from frigate.camera import PTZMetrics
from frigate.config import FrigateConfig
from frigate.const import AUTOTRACKING_MAX_AREA_RATIO
from frigate.ptz import autotrack as autotrack_module
from frigate.ptz.autotrack import (
    PtzAutoTracker,
    PtzAutoTrackerThread,
    PtzMotionEstimator,
    ptz_moving_at_frame_time,
    transform_is_finite,
)

CAMERA = "ptz_cam"
WIDTH = 1920
HEIGHT = 1080
FPS = 5
WEIGHTS = "0.0, 1.0, 0.5, 0.5, 1.0, 2.0"


def _config(
    zooming: str = "disabled",
    weights: str | None = None,
    enabled: bool = True,
    calibrate: bool = False,
    extra_cameras: dict[str, Any] | None = None,
) -> FrigateConfig:
    """A fresh config; parsing is slow, so plain variants are cached and copied."""
    if extra_cameras:
        return _build_config(zooming, weights, enabled, calibrate, extra_cameras)
    return copy.deepcopy(_cached_config(zooming, weights, enabled, calibrate))


@functools.cache
def _cached_config(
    zooming: str, weights: str | None, enabled: bool, calibrate: bool
) -> FrigateConfig:
    return _build_config(zooming, weights, enabled, calibrate, None)


def _build_config(
    zooming: str,
    weights: str | None,
    enabled: bool,
    calibrate: bool,
    extra_cameras: dict[str, Any] | None,
) -> FrigateConfig:
    autotracking: dict[str, Any] = {
        "enabled": enabled,
        "required_zones": ["zone"],
        "zooming": zooming,
        "calibrate_on_startup": calibrate,
        "track": ["person"],
    }
    if weights is not None:
        autotracking["movement_weights"] = weights

    cameras: dict[str, Any] = {
        CAMERA: {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
            },
            "detect": {"width": WIDTH, "height": HEIGHT, "fps": FPS},
            "zones": {"zone": {"coordinates": "0,0,1,0,1,1,0,1"}},
            "onvif": {"host": "10.0.0.1", "autotracking": autotracking},
        }
    }
    cameras.update(extra_cameras or {})
    return FrigateConfig(mqtt={"enabled": False}, cameras=cameras)


def _plain_camera(enabled: bool = True, autotrack: bool = False) -> dict[str, Any]:
    return {
        "enabled": enabled,
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
        },
        "detect": {"width": 640, "height": 360},
        "zones": {"zone": {"coordinates": "0,0,1,0,1,1,0,1"}},
        "onvif": {
            "host": "10.0.0.2",
            "autotracking": {"enabled": autotrack, "required_zones": ["zone"]},
        },
    }


def _onvif(features: list[str] | None = None, init: bool = True) -> MagicMock:
    onvif = MagicMock()
    onvif.cams = {
        CAMERA: {
            "init": init,
            "features": features if features is not None else ["pt", "pt-r-fov"],
            "absolute_zoom_range": {"XRange": {"Min": 0.0, "Max": 10.0}},
        }
    }
    onvif._init_onvif = AsyncMock(return_value=True)
    onvif.get_service_capabilities = AsyncMock(return_value=True)
    onvif.get_camera_status = AsyncMock()
    onvif._move_relative = AsyncMock()
    onvif._zoom_absolute = AsyncMock()
    onvif._move_to_preset = AsyncMock()
    return onvif


def _tracker(
    zooming: str = "disabled",
    weights: str | None = None,
    calibrate: bool = False,
    config: FrigateConfig | None = None,
) -> PtzAutoTracker:
    """A tracker in the state _autotracker_setup leaves it in, built without
    __init__ so no ONVIF setup or config subscriber is created."""
    tracker = PtzAutoTracker.__new__(PtzAutoTracker)
    tracker.config = config or _config(zooming, weights, calibrate=calibrate)
    tracker.onvif = _onvif()
    tracker.ptz_metrics = {CAMERA: PTZMetrics(autotracker_enabled=True)}
    tracker.dispatcher = MagicMock()
    tracker.stop_event = MagicMock()
    tracker.stop_event.is_set.return_value = False
    tracker.config_subscriber = MagicMock()
    zoom_factor = tracker.config.cameras[CAMERA].onvif.autotracking.zoom_factor
    tracker.tracked_object = {CAMERA: None}
    tracker.tracked_object_history = {CAMERA: deque(maxlen=8)}
    tracker.tracked_object_metrics = {
        CAMERA: {"max_target_box": AUTOTRACKING_MAX_AREA_RATIO ** (1 / zoom_factor)}
    }
    tracker.object_types = {CAMERA: ["person"]}
    tracker.required_zones = {CAMERA: ["zone"]}
    tracker.move_queues = {}
    tracker.move_queue_locks = {CAMERA: asyncio.Lock()}
    tracker.move_threads = {}
    tracker.autotracker_init = {CAMERA: True}
    tracker.move_metrics = {CAMERA: []}
    tracker.calibrating = {CAMERA: False}
    tracker.intercept = {CAMERA: 0.5 if weights else None}
    tracker.move_coefficients = {CAMERA: [0.5, 1.0] if weights else []}
    tracker.zoom_time = {CAMERA: 2.0}
    tracker.zoom_factor = {CAMERA: zoom_factor}
    return tracker


def _obj(
    obj_id: str = "obj1",
    box: tuple[int, int, int, int] = (900, 480, 1020, 600),
    frame_time: float = 100.0,
    label: str = "person",
    zones: list[str] | None = None,
    velocity: Any = None,
    region: tuple[int, int, int, int] = (700, 300, 1220, 820),
    false_positive: bool = False,
    active: bool = True,
    camera: str = CAMERA,
) -> SimpleNamespace:
    centroid = ((box[0] + box[2]) // 2, (box[1] + box[3]) // 2)
    return SimpleNamespace(
        obj_data={
            "id": obj_id,
            "box": box,
            "frame_time": frame_time,
            "label": label,
            "centroid": centroid,
            "estimate_velocity": (
                np.zeros((2, 2)) if velocity is None else np.array(velocity)
            ),
            "region": region,
        },
        camera_config=SimpleNamespace(name=camera),
        entered_zones=["zone"] if zones is None else zones,
        previous={"false_positive": False},
        false_positive=false_positive,
        active=active,
    )


def _close_coroutine(coro, loop):
    """Stand-in for run_coroutine_threadsafe that never schedules the work."""
    coro.close()
    return MagicMock()


class TestPtzMovingAtFrameTime(unittest.TestCase):
    def test_never_moving_before_first_move(self) -> None:
        self.assertFalse(ptz_moving_at_frame_time(10.0, 0.0, 0.0))

    def test_moving_after_start_with_no_stop(self) -> None:
        self.assertTrue(ptz_moving_at_frame_time(10.0, 5.0, 0.0))

    def test_frame_before_start_is_not_moving(self) -> None:
        self.assertFalse(ptz_moving_at_frame_time(4.0, 5.0, 0.0))

    def test_moving_between_start_and_stop(self) -> None:
        self.assertTrue(ptz_moving_at_frame_time(6.0, 5.0, 7.0))

    def test_frame_after_stop_is_not_moving(self) -> None:
        self.assertFalse(ptz_moving_at_frame_time(8.0, 5.0, 7.0))


class TestTransformIsFinite(unittest.TestCase):
    def test_finite_and_missing_attributes(self) -> None:
        transform = SimpleNamespace(homography_matrix=np.eye(3))
        self.assertTrue(transform_is_finite(transform))
        self.assertTrue(transform_is_finite(object()))

    def test_nan_or_inf_values_are_rejected(self) -> None:
        for attr in (
            "homography_matrix",
            "inverse_homography_matrix",
            "movement_vector",
        ):
            with self.subTest(attr=attr):
                value = np.array([1.0, np.nan if attr != "movement_vector" else np.inf])
                self.assertFalse(transform_is_finite(SimpleNamespace(**{attr: value})))


class TestPtzMotionEstimator(unittest.TestCase):
    def setUp(self) -> None:
        frame_manager_patch = patch.object(autotrack_module, "SharedMemoryFrameManager")
        self.frame_manager = frame_manager_patch.start().return_value
        self.addCleanup(frame_manager_patch.stop)
        estimator_patch = patch.object(autotrack_module, "MotionEstimator")
        self.estimator_cls = estimator_patch.start()
        self.addCleanup(estimator_patch.stop)
        self.norfair = self.estimator_cls.return_value

    def _estimator(self, zooming: str = "disabled") -> PtzMotionEstimator:
        config = _config(zooming).cameras[CAMERA]
        self.metrics = PTZMetrics(autotracker_enabled=True)
        return PtzMotionEstimator(config, self.metrics)

    def _moving(self) -> None:
        self.metrics.start_time.value = 10.0
        self.metrics.stop_time.value = 0.0

    def test_init_requests_a_reset(self) -> None:
        self._estimator()
        self.assertTrue(self.metrics.reset.is_set())

    def test_reset_uses_translation_when_zooming_disabled(self) -> None:
        estimator = self._estimator("disabled")
        with patch.object(
            autotrack_module, "TranslationTransformationGetter"
        ) as translation:
            result = estimator.motion_estimator([], "frame", 1.0, CAMERA)

        self.assertIsNone(result)
        self.assertFalse(self.metrics.reset.is_set())
        self.assertIs(
            self.estimator_cls.call_args.kwargs["transformations_getter"],
            translation.return_value,
        )
        # not moving, so the frame is never read
        self.frame_manager.get.assert_not_called()

    def test_reset_uses_homography_when_zooming(self) -> None:
        estimator = self._estimator("absolute")
        with patch.object(
            autotrack_module, "HomographyTransformationGetter"
        ) as homography:
            estimator.motion_estimator([], "frame", 1.0, CAMERA)

        self.assertIs(
            self.estimator_cls.call_args.kwargs["transformations_getter"],
            homography.return_value,
        )

    def test_missing_frame_clears_transformations(self) -> None:
        estimator = self._estimator()
        self._moving()
        self.frame_manager.get.return_value = None

        self.assertIsNone(estimator.motion_estimator([], "frame", 11.0, CAMERA))
        self.frame_manager.close.assert_not_called()

    def test_masks_detections_and_returns_transformation(self) -> None:
        estimator = self._estimator()
        self._moving()
        config = estimator.camera_config
        self.frame_manager.get.return_value = np.full(
            config.frame_shape_yuv, 128, np.uint8
        )
        transform = MagicMock(
            homography_matrix=np.eye(3),
            inverse_homography_matrix=np.eye(3),
            movement_vector=np.zeros(2),
        )
        self.norfair.update.return_value = transform
        detections = [("person", 0.9, (10, 20, 30, 40), 400, 1.0, (0, 0, 1, 1))]

        result = estimator.motion_estimator(detections, "frame", 11.0, CAMERA)

        self.assertIs(result, transform)
        frame, mask = self.norfair.update.call_args.args
        self.assertEqual(frame.shape, (HEIGHT, WIDTH, 4))
        self.assertEqual(mask[25, 15], 0)
        self.assertEqual(mask[0, 0], 1)
        self.assertEqual(mask.max(), 1)
        transform.rel_to_abs.assert_called_once_with([[0, 0]])
        self.frame_manager.close.assert_called_once_with("frame")

    def test_estimator_failure_returns_none(self) -> None:
        estimator = self._estimator()
        self._moving()
        self.frame_manager.get.return_value = np.zeros(
            estimator.camera_config.frame_shape_yuv, np.uint8
        )
        self.norfair.update.side_effect = ValueError("no features")

        with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
            result = estimator.motion_estimator([], "frame", 11.0, CAMERA)

        self.assertIsNone(result)
        self.assertIn("couldn't get transformations", logs.output[0])
        self.frame_manager.close.assert_called_once_with("frame")

    def test_non_finite_transform_requests_reset(self) -> None:
        estimator = self._estimator()
        estimator.motion_estimator([], "frame", 1.0, CAMERA)
        self._moving()
        self.frame_manager.get.return_value = np.zeros(
            estimator.camera_config.frame_shape_yuv, np.uint8
        )
        self.norfair.update.return_value = SimpleNamespace(
            homography_matrix=np.array([[np.inf]])
        )

        with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
            result = estimator.motion_estimator([], "frame", 11.0, CAMERA)

        self.assertIsNone(result)
        self.assertTrue(self.metrics.reset.is_set())
        self.assertIn("non-finite transform", logs.output[0])


class TestPtzAutoTrackerThread(unittest.TestCase):
    def _thread(self, config: FrigateConfig) -> tuple[PtzAutoTrackerThread, Any]:
        stop_event = MagicMock()
        stop_event.wait.side_effect = [False, True]
        with patch.object(autotrack_module, "PtzAutoTracker") as tracker_cls:
            thread = PtzAutoTrackerThread(
                config, MagicMock(), {}, MagicMock(), stop_event
            )
        return thread, tracker_cls.return_value

    def test_run_maintains_enabled_autotracking_cameras(self) -> None:
        config = _config(
            extra_cameras={
                "off_cam": _plain_camera(enabled=False),
                "plain_cam": _plain_camera(),
            }
        )
        thread, tracker = self._thread(config)
        tracker.camera_maintenance = MagicMock(return_value="coro")
        tracker.tracked_object = {"plain_cam": None}
        future = MagicMock()

        with (
            patch.object(
                autotrack_module.asyncio,
                "run_coroutine_threadsafe",
                return_value=future,
            ) as run,
            self.assertLogs("frigate.ptz.autotrack", "INFO") as logs,
        ):
            thread.run()

        tracker.check_for_updates.assert_called_once()
        tracker.camera_maintenance.assert_called_once_with(CAMERA)
        run.assert_called_once_with("coro", tracker.onvif.loop)
        future.result.assert_called_once()
        tracker.config_subscriber.stop.assert_called_once()
        self.assertIn("Exiting autotracker", logs.output[-1])

    def test_run_clears_tracking_when_disabled_dynamically(self) -> None:
        config = _config(enabled=False)
        thread, tracker = self._thread(config)
        history = deque([{"frame_time": 1.0}])
        tracker.tracked_object = {CAMERA: object()}
        tracker.tracked_object_history = {CAMERA: history}

        thread.run()

        self.assertIsNone(tracker.tracked_object[CAMERA])
        self.assertEqual(len(history), 0)


class TestPtzAutoTrackerInit(unittest.TestCase):
    def test_init_sets_up_cameras_enabled_in_config(self) -> None:
        config = _config(
            extra_cameras={
                "off_cam": _plain_camera(enabled=False),
                "plain_cam": _plain_camera(),
            }
        )
        onvif = MagicMock()
        scheduled = []

        def fake_run(coro, loop):
            scheduled.append(coro.cr_code.co_name)
            coro.close()
            return MagicMock()

        with (
            patch.object(autotrack_module, "CameraConfigUpdateSubscriber") as sub,
            patch.object(
                autotrack_module.asyncio,
                "run_coroutine_threadsafe",
                side_effect=fake_run,
            ),
        ):
            tracker = PtzAutoTracker(config, onvif, {}, MagicMock(), MagicMock())

        self.assertIs(tracker.config_subscriber, sub.return_value)
        self.assertEqual(tracker.autotracker_init, {CAMERA: False, "plain_cam": False})
        self.assertEqual(scheduled, ["_autotracker_setup"])


class TestCheckForUpdates(unittest.TestCase):
    def test_mirrors_autotracking_state_to_metrics(self) -> None:
        tracker = _tracker()
        metrics = tracker.ptz_metrics[CAMERA]
        metrics.autotracker_enabled.value = False
        tracker.config_subscriber.check_for_updates.return_value = {
            "autotracking": [CAMERA, "gone"]
        }

        tracker.check_for_updates()

        self.assertTrue(metrics.autotracker_enabled.value)


class TestAutotrackerSetup(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        run_patch = patch.object(
            autotrack_module.asyncio,
            "run_coroutine_threadsafe",
            side_effect=_close_coroutine,
        )
        self.run = run_patch.start()
        self.addCleanup(run_patch.stop)

    async def _setup(self, tracker: PtzAutoTracker) -> None:
        await tracker._autotracker_setup(tracker.config.cameras[CAMERA], CAMERA)

    def _assert_disabled(self, tracker: PtzAutoTracker) -> None:
        self.assertFalse(tracker.config.cameras[CAMERA].onvif.autotracking.enabled)
        self.assertFalse(tracker.ptz_metrics[CAMERA].autotracker_enabled.value)
        self.assertTrue(tracker.autotracker_init[CAMERA])

    async def test_missing_onvif_connection_disables(self) -> None:
        tracker = _tracker()
        tracker.onvif.cams = {}

        with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
            await self._setup(tracker)

        self.assertFalse(tracker.config.cameras[CAMERA].onvif.autotracking.enabled)
        self.assertFalse(tracker.ptz_metrics[CAMERA].autotracker_enabled.value)
        self.assertIn("onvif connection failed", logs.output[0])
        self.assertIsInstance(tracker.move_queues[CAMERA], asyncio.Queue)
        self.assertEqual(tracker.tracked_object_history[CAMERA].maxlen, 8)

    async def test_failed_onvif_init_disables(self) -> None:
        tracker = _tracker()
        tracker.onvif = _onvif(init=False)
        tracker.onvif._init_onvif.return_value = False

        with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
            await self._setup(tracker)

        self.assertFalse(tracker.config.cameras[CAMERA].onvif.autotracking.enabled)
        self.assertIn("Unable to initialize onvif", logs.output[0])

    async def test_missing_relative_fov_support_disables(self) -> None:
        tracker = _tracker()
        tracker.onvif = _onvif(features=["pt"], init=False)

        with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
            await self._setup(tracker)

        self.assertFalse(tracker.config.cameras[CAMERA].onvif.autotracking.enabled)
        self.assertIn("FOV relative movement not supported", logs.output[0])

    async def test_move_status_capability_values(self) -> None:
        for capability, supported in (
            (True, True),
            ("TRUE", True),
            (False, False),
            ("false", False),
            (None, False),
        ):
            with self.subTest(capability=capability):
                tracker = _tracker()
                tracker.onvif = _onvif(init=False)
                tracker.onvif.get_service_capabilities.return_value = capability

                if supported:
                    await self._setup(tracker)
                    self.assertTrue(
                        tracker.config.cameras[CAMERA].onvif.autotracking.enabled
                    )
                else:
                    with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
                        await self._setup(tracker)
                    self.assertFalse(
                        tracker.config.cameras[CAMERA].onvif.autotracking.enabled
                    )
                    self.assertIn("MoveStatus not supported", logs.output[0])

    async def test_initialized_camera_loads_movement_weights(self) -> None:
        tracker = _tracker(weights=WEIGHTS)
        metrics = tracker.ptz_metrics[CAMERA]
        metrics.tracking_active.set()

        await self._setup(tracker)

        tracker.onvif.get_camera_status.assert_awaited_once_with(CAMERA)
        self.run.assert_called_once()
        self.assertEqual(metrics.min_zoom.value, 0.0)
        self.assertEqual(metrics.max_zoom.value, 1.0)
        self.assertEqual(tracker.intercept[CAMERA], 0.5)
        self.assertEqual(tracker.move_coefficients[CAMERA], [0.5, 1.0])
        self.assertEqual(tracker.zoom_time[CAMERA], 2.0)
        self.assertEqual(
            tracker.config.cameras[CAMERA].onvif.autotracking.movement_weights,
            [0.0, 1.0, 0.5, 0.5, 1.0, 2.0],
        )
        self.assertFalse(metrics.tracking_active.is_set())
        tracker.dispatcher.publish.assert_called_once_with(
            f"{CAMERA}/ptz_autotracker/active", "OFF", retain=False
        )
        self.assertTrue(tracker.autotracker_init[CAMERA])
        self.assertIsNone(tracker.tracked_object[CAMERA])
        self.assertFalse(tracker.calibrating[CAMERA])

    async def test_wrong_number_of_weights_requires_recalibration(self) -> None:
        tracker = _tracker()
        tracker.config.cameras[CAMERA].onvif.autotracking.movement_weights = [
            "1.0",
            "2.0",
        ]

        with self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs:
            await self._setup(tracker)

        self._assert_disabled(tracker)
        self.assertIn("recalibration is required", logs.output[0])

    async def test_calibrate_on_startup_runs_calibration(self) -> None:
        tracker = _tracker(calibrate=True)

        with patch.object(tracker, "_calibrate_camera", AsyncMock()) as calibrate:
            await self._setup(tracker)

        calibrate.assert_awaited_once_with(CAMERA)


class TestWriteConfig(unittest.TestCase):
    def test_writes_movement_weights_to_the_config_file(self) -> None:
        tracker = _tracker(weights=WEIGHTS)

        with (
            patch.object(
                autotrack_module, "find_config_file", return_value="/config/c.yml"
            ),
            patch.object(autotrack_module, "update_yaml_file_bulk") as update,
        ):
            tracker._write_config(CAMERA)

        update.assert_called_once_with(
            "/config/c.yml",
            {
                f"cameras.{CAMERA}.onvif.autotracking.movement_weights": [
                    "0.0",
                    "1.0",
                    "0.5",
                    "0.5",
                    "1.0",
                    "2.0",
                ]
            },
        )


class _FakePtz:
    """Simulated camera: each move takes 0.5 s plus 1 s per unit of pan+tilt
    on a fake clock, and the motor reports stopped on the next status poll."""

    def __init__(self, tracker: PtzAutoTracker) -> None:
        self.clock = 1000.0
        self.metrics = tracker.ptz_metrics[CAMERA]
        onvif = tracker.onvif
        onvif._move_relative.side_effect = self.move_relative
        onvif._zoom_absolute.side_effect = self.zoom_absolute
        onvif._move_to_preset.side_effect = self.move_to_preset
        onvif.get_camera_status.side_effect = self.status
        self.moves: list[tuple[float, float, float]] = []

    def time(self) -> float:
        return self.clock

    async def move_relative(self, camera, pan, tilt, zoom, speed) -> None:
        self.moves.append((pan, tilt, zoom))
        self.clock += 0.5 + abs(pan) + abs(tilt)
        self.metrics.zoom_level.value = min(
            1.0, max(0.0, self.metrics.zoom_level.value + zoom)
        )
        self.metrics.motor_stopped.clear()

    async def zoom_absolute(self, camera, zoom, speed) -> None:
        self.metrics.zoom_level.value = zoom / 10
        self.metrics.motor_stopped.clear()

    async def move_to_preset(self, camera, preset) -> None:
        self.metrics.zoom_level.value = 0.0

    async def status(self, camera) -> None:
        self.metrics.motor_stopped.set()


class TestCalibrateCamera(unittest.IsolatedAsyncioTestCase):
    async def _calibrate(self, zooming: str) -> tuple[PtzAutoTracker, _FakePtz, Any]:
        tracker = _tracker(zooming)
        tracker.zoom_time = {}
        tracker.intercept = {CAMERA: None}
        fake = _FakePtz(tracker)
        with (
            patch.object(autotrack_module.time, "time", side_effect=fake.time),
            patch.object(tracker, "_write_config") as write,
            self.assertLogs("frigate.ptz.autotrack", "INFO"),
        ):
            await tracker._calibrate_camera(CAMERA)
        return tracker, fake, write

    def _assert_regression(self, tracker: PtzAutoTracker, write: Any) -> None:
        self.assertFalse(tracker.calibrating[CAMERA])
        self.assertEqual(len(tracker.move_metrics[CAMERA]), 30)
        self.assertAlmostEqual(tracker.intercept[CAMERA], 0.5)
        intercept, slope = tracker.move_coefficients[CAMERA]
        self.assertAlmostEqual(intercept, 0.5)
        self.assertAlmostEqual(slope, 1.0)
        write.assert_called_once_with(CAMERA)
        weights = tracker.config.cameras[CAMERA].onvif.autotracking.movement_weights
        self.assertIsInstance(weights, str)
        self.assertEqual(len(weights.split(", ")), 6)

    async def test_calibration_without_zoom(self) -> None:
        tracker, fake, write = await self._calibrate("disabled")

        metrics = tracker.ptz_metrics[CAMERA]
        self.assertEqual(metrics.max_zoom.value, 1)
        self.assertEqual(metrics.min_zoom.value, 0)
        self.assertEqual(tracker.zoom_time[CAMERA], 0)
        tracker.onvif._zoom_absolute.assert_not_awaited()
        # one move to preset before the steps, then one after each step
        self.assertEqual(tracker.onvif._move_to_preset.await_count, 31)
        tracker.onvif._move_to_preset.assert_awaited_with(CAMERA, "home")
        self.assertTrue(metrics.reset.is_set())
        self._assert_regression(tracker, write)

    async def test_calibration_with_absolute_zoom(self) -> None:
        tracker, fake, write = await self._calibrate("absolute")

        metrics = tracker.ptz_metrics[CAMERA]
        self.assertEqual(metrics.max_zoom.value, 1.0)
        self.assertEqual(metrics.min_zoom.value, 0.0)
        self.assertEqual(tracker.onvif._zoom_absolute.await_count, 4)
        self.assertEqual(tracker.zoom_time[CAMERA], 0)
        self._assert_regression(tracker, write)

    async def test_calibration_with_relative_zoom_measures_zoom_time(self) -> None:
        tracker, fake, write = await self._calibrate("relative")

        # full move (-1, -1) takes 2.5 s, a zoom only move 0.5 s
        self.assertAlmostEqual(tracker.zoom_time[CAMERA], 2.0)
        self.assertIn((-1, -1, -1e-2), fake.moves)
        self.assertIn((1, 1, 1e-2), fake.moves)
        self._assert_regression(tracker, write)


class TestMoveCoefficients(unittest.TestCase):
    def _metrics(self, count: int, slope: float) -> list[dict[str, float]]:
        return [
            {
                "pan": i / count,
                "tilt": 0.0,
                "start_timestamp": 0.0,
                "end_timestamp": 0.5 + slope * (i / count),
            }
            for i in range(count)
        ]

    def test_waits_for_fifty_new_values(self) -> None:
        tracker = _tracker(weights=WEIGHTS)
        tracker.move_metrics[CAMERA] = self._metrics(49, 1.0)

        with patch.object(tracker, "_write_config") as write:
            self.assertIsNone(tracker._calculate_move_coefficients(CAMERA))

        write.assert_not_called()
        self.assertEqual(tracker.move_coefficients[CAMERA], [0.5, 1.0])

    def test_recomputes_coefficients_but_keeps_intercept(self) -> None:
        tracker = _tracker(weights=WEIGHTS)
        tracker.intercept[CAMERA] = 0.7
        tracker.move_metrics[CAMERA] = self._metrics(50, 1.5)

        with patch.object(tracker, "_write_config") as write:
            tracker._calculate_move_coefficients(CAMERA)

        write.assert_called_once_with(CAMERA)
        self.assertAlmostEqual(tracker.move_coefficients[CAMERA][1], 1.5)
        self.assertEqual(tracker.intercept[CAMERA], 0.7)
        weights = tracker.config.cameras[CAMERA].onvif.autotracking.movement_weights
        self.assertTrue(weights.startswith("0.0, 0.0, 0.7, "))
        self.assertTrue(weights.endswith(", 2.0"))

    def test_invalid_regression_is_rejected(self) -> None:
        tracker = _tracker(weights=WEIGHTS)
        # slower small moves than large ones gives a negative slope
        tracker.move_metrics[CAMERA] = self._metrics(50, -0.3)

        with (
            patch.object(tracker, "_write_config") as write,
            self.assertLogs("frigate.ptz.autotrack", "WARNING") as logs,
        ):
            result = tracker._calculate_move_coefficients(CAMERA)

        self.assertFalse(result)
        write.assert_not_called()
        self.assertIn("calibration failed", logs.output[0])
        self.assertEqual(tracker.move_coefficients[CAMERA], [0.5, 1.0])


class TestPredictions(unittest.TestCase):
    def test_predict_movement_time(self) -> None:
        tracker = _tracker(weights=WEIGHTS)

        # Upstream oddity: the stored intercept (a measured time) is multiplied
        # by the regression intercept term instead of adding it as a constant
        self.assertAlmostEqual(
            tracker._predict_movement_time(CAMERA, 0.25, -0.5), 0.5 * 0.5 + 0.75
        )

    def test_predict_area_after_time(self) -> None:
        tracker = _tracker()
        tracker.tracked_object_metrics[CAMERA]["area_coefficients"] = np.array([2.0])
        tracker.tracked_object_history[CAMERA].append({"frame_time": 10.0})

        self.assertAlmostEqual(
            float(tracker._predict_area_after_time(CAMERA, 1.5)), 23.0
        )


class TestTrackedObjectMetrics(unittest.TestCase):
    def _history(self, tracker: PtzAutoTracker, entries: list[dict]) -> None:
        tracker.tracked_object_history[CAMERA].extend(entries)

    def test_metrics_from_recent_history_with_outliers(self) -> None:
        tracker = _tracker()
        boxes = [
            (900, 480, 1000, 580),
            (900, 480, 1000, 580),
            (900, 480, 1000, 580),
            (900, 480, 1000, 580),
            (0, 0, 1000, 1000),  # outlier and touching edges
        ]
        self._history(
            tracker,
            [
                {"frame_time": 99.0, "box": boxes[0], "is_initial_frame": True},
                {"frame_time": 90.0, "box": boxes[0]},  # outside time window
            ]
            + [
                {"frame_time": 99.0 + i * 0.2, "box": box}
                for i, box in enumerate(boxes)
            ],
        )
        obj = _obj(box=(910, 490, 1010, 590), frame_time=100.0)

        tracker._calculate_tracked_object_metrics(CAMERA, obj)

        metrics = tracker.tracked_object_metrics[CAMERA]
        expected_target = (100**2 / (WIDTH * HEIGHT)) ** tracker.zoom_factor[CAMERA]
        self.assertAlmostEqual(metrics["target_box"], expected_target)
        self.assertAlmostEqual(metrics["original_target_box"], expected_target)
        self.assertTrue(metrics["valid_velocity"])
        np.testing.assert_array_equal(metrics["velocity"], np.zeros(4))
        self.assertTrue(metrics["below_distance_threshold"])
        self.assertEqual(metrics["area_coefficients"].shape, (1,))

    def test_falls_back_to_latest_entry_touching_edges(self) -> None:
        tracker = _tracker()
        self._history(
            tracker,
            [{"frame_time": 50.0, "box": (0, 0, 200, 100), "is_initial_frame": True}],
        )
        tracker.tracked_object_metrics[CAMERA]["original_target_box"] = 0.123
        obj = _obj(box=(0, 0, 200, 100), frame_time=100.0)

        tracker._calculate_tracked_object_metrics(CAMERA, obj)

        metrics = tracker.tracked_object_metrics[CAMERA]
        np.testing.assert_array_equal(metrics["area_coefficients"], np.array([0]))
        self.assertEqual(metrics["original_target_box"], 0.123)
        self.assertFalse(metrics["below_distance_threshold"])


class TestProcessMoveQueue(unittest.IsolatedAsyncioTestCase):
    async def _run(
        self, tracker: PtzAutoTracker, moves: list[tuple], loops: int | None = None
    ) -> None:
        tracker.move_queues = {CAMERA: asyncio.Queue()}
        tracker.move_queue_locks = {CAMERA: asyncio.Lock()}
        for move in moves:
            tracker.move_queues[CAMERA].put_nowait(move)
        count = len(moves) if loops is None else loops
        tracker.stop_event.is_set.side_effect = [False] * count + [True]
        await tracker._process_move_queue(CAMERA)

    async def test_timeout_keeps_waiting(self) -> None:
        tracker = _tracker()

        async def timeout(coro, timeout):
            coro.close()
            raise TimeoutError

        with patch.object(autotrack_module.asyncio, "wait_for", side_effect=timeout):
            await self._run(tracker, [], loops=2)

        tracker.onvif._move_relative.assert_not_awaited()

    async def test_drops_moves_for_removed_camera(self) -> None:
        tracker = _tracker()
        tracker.ptz_metrics = {}

        await self._run(tracker, [(1.0, 0.2, 0.2, 0)])

        tracker.onvif._move_relative.assert_not_awaited()

    async def test_drops_moves_requested_while_moving(self) -> None:
        tracker = _tracker()
        metrics = tracker.ptz_metrics[CAMERA]
        metrics.start_time.value = 5.0

        await self._run(tracker, [(10.0, 0.2, 0.2, 0)])

        tracker.onvif._move_relative.assert_not_awaited()

    async def test_relative_zoom_moves_together_and_records_metrics(self) -> None:
        tracker = _tracker("relative", weights=WEIGHTS, calibrate=True)
        fake = _FakePtz(tracker)

        with patch.object(tracker, "_calculate_move_coefficients") as calc:
            await self._run(tracker, [(1.0, 0.2, -0.1, 0.3)])

        self.assertEqual(fake.moves, [(0.2, -0.1, 0.3)])
        tracker.onvif.get_camera_status.assert_awaited()
        self.assertEqual(len(tracker.move_metrics[CAMERA]), 1)
        self.assertEqual(tracker.move_metrics[CAMERA][0]["pan"], 0.2)
        calc.assert_called_once_with(CAMERA)

    async def test_absolute_zoom_waits_for_pan_before_zooming(self) -> None:
        tracker = _tracker("absolute")
        fake = _FakePtz(tracker)
        tracker.ptz_metrics[CAMERA].zoom_level.value = 0.4

        await self._run(tracker, [(1.0, 0.3, 0.1, 0.4)])

        # zoom already at the requested level, so only pan/tilt moves
        self.assertEqual(fake.moves, [(0.3, 0.1, 0)])
        tracker.onvif._zoom_absolute.assert_not_awaited()
        tracker.onvif.get_camera_status.assert_awaited_once_with(CAMERA)

    async def test_zoom_only_move_skips_pan_tilt(self) -> None:
        tracker = _tracker("absolute")

        await self._run(tracker, [(1.0, 0, 0, 0.4)])

        tracker.onvif._move_relative.assert_not_awaited()
        tracker.onvif._zoom_absolute.assert_awaited_once_with(CAMERA, 0.4, 1)
        self.assertEqual(tracker.move_metrics[CAMERA], [])

    async def test_drains_queue_on_exit(self) -> None:
        tracker = _tracker()

        await self._run(tracker, [(1.0, 0.1, 0.1, 0), (2.0, 0.1, 0.1, 0)], loops=0)

        self.assertTrue(tracker.move_queues[CAMERA].empty())
        tracker.onvif._move_relative.assert_not_awaited()


class TestEnqueueMove(unittest.TestCase):
    def _queued(self, tracker: PtzAutoTracker) -> list[tuple]:
        return [c.args[1] for c in tracker.onvif.loop.call_soon_threadsafe.mock_calls]

    def test_clips_and_suppresses_small_moves(self) -> None:
        tracker = _tracker()
        tracker.move_queues = {CAMERA: MagicMock()}

        tracker._enqueue_move(CAMERA, 10.0, 1.7, 0.03, 0.02)

        # Upstream bug: split_value only zeroes the discarded diff for moves
        # inside (-0.05, 0.05) and still returns the clipped value, so the
        # "don't make small movements" suppression never takes effect and the
        # 0.03 tilt is enqueued unchanged
        self.assertEqual(self._queued(tracker), [(10.0, 1.0, 0.03, 0.02)])
        call = tracker.onvif.loop.call_soon_threadsafe.call_args
        self.assertIs(call.args[0], tracker.move_queues[CAMERA].put_nowait)

    def test_no_move_when_all_zero(self) -> None:
        tracker = _tracker()
        tracker._enqueue_move(CAMERA, 10.0, 0, 0, 0)
        self.assertEqual(self._queued(tracker), [])

    def test_ignores_stale_frames_and_locked_queue(self) -> None:
        tracker = _tracker()
        tracker.ptz_metrics[CAMERA].stop_time.value = 20.0
        tracker._enqueue_move(CAMERA, 10.0, 0.5, 0.5, 0)
        self.assertEqual(self._queued(tracker), [])

        tracker = _tracker()
        tracker.move_queue_locks[CAMERA] = MagicMock()
        tracker.move_queue_locks[CAMERA].locked.return_value = True
        tracker._enqueue_move(CAMERA, 10.0, 0.5, 0.5, 0)
        self.assertEqual(self._queued(tracker), [])


class TestGeometry(unittest.TestCase):
    def test_touching_frame_edges_counts_each_edge(self) -> None:
        tracker = _tracker()
        self.assertEqual(tracker._touching_frame_edges(CAMERA, (500, 500, 600, 600)), 0)
        self.assertEqual(tracker._touching_frame_edges(CAMERA, (0, 500, 600, 600)), 1)
        self.assertEqual(
            tracker._touching_frame_edges(CAMERA, (0, 0, WIDTH, HEIGHT)), 4
        )

    def test_valid_velocity_cases(self) -> None:
        tracker = _tracker()
        cases = {
            "zero": ([[0.2, 0.1], [0.1, 0.0]], True, np.zeros(4)),
            "steady": ([[10, 5], [10, 5]], True, np.array([10, 5, 10, 5])),
            "too fast": ([[300, 0], [300, 0]], False, np.zeros(4)),
            "opposed": ([[5, 0], [0, 5]], False, np.zeros(4)),
            "large delta": ([[60, 0], [20, 0]], False, np.zeros(4)),
        }
        for name, (velocity, valid, expected) in cases.items():
            with self.subTest(name=name):
                result = tracker._get_valid_velocity(CAMERA, _obj(velocity=velocity))
                self.assertEqual(bool(result[0]), valid)
                np.testing.assert_array_equal(result[1], expected)

    def test_distance_threshold_depends_on_size_and_weights(self) -> None:
        obj = _obj(box=(0, 0, 192, 100))
        scaling = 1 - np.log(192 / WIDTH)

        tracker = _tracker()
        self.assertAlmostEqual(
            tracker._get_distance_threshold(CAMERA, obj), 0.03 * WIDTH * scaling
        )

        tracker = _tracker(weights=WEIGHTS)
        tracker.tracked_object_metrics[CAMERA]["valid_velocity"] = True
        self.assertAlmostEqual(
            tracker._get_distance_threshold(CAMERA, obj), 0.08 * WIDTH * scaling
        )

        tall = _obj(box=(0, 0, 50, 540))
        self.assertAlmostEqual(
            tracker._get_distance_threshold(CAMERA, tall),
            0.08 * HEIGHT * (1 - np.log(0.5)),
        )


class TestShouldZoomIn(unittest.TestCase):
    def _tracker(self, target_box: float, weights: str | None = None, **metrics):
        tracker = _tracker(weights=weights)
        tracker.tracked_object_metrics[CAMERA].update(
            {
                "velocity": np.zeros(4),
                "below_distance_threshold": True,
                "target_box": target_box,
                "original_target_box": target_box,
                **metrics,
            }
        )
        ptz = tracker.ptz_metrics[CAMERA]
        ptz.min_zoom.value = 0.0
        ptz.max_zoom.value = 1.0
        ptz.zoom_level.value = 0.5
        return tracker

    def test_small_centered_object_zooms_in(self) -> None:
        tracker = self._tracker(0.05)
        self.assertTrue(
            tracker._should_zoom_in(
                CAMERA, _obj(), (900, 480, 1020, 600), 0, debug_zooming=True
            )
        )

    def test_no_zoom_in_at_max_zoom(self) -> None:
        tracker = self._tracker(0.05)
        tracker.ptz_metrics[CAMERA].zoom_level.value = 1.0
        self.assertIsNone(
            tracker._should_zoom_in(CAMERA, _obj(), (900, 480, 1020, 600), 0)
        )

    def test_edges_or_velocity_zoom_out(self) -> None:
        tracker = self._tracker(0.05)
        self.assertFalse(tracker._should_zoom_in(CAMERA, _obj(), (0, 0, 1020, 600), 0))

        fast = self._tracker(0.05, velocity=np.array([100, 0, 100, 0]))
        self.assertFalse(fast._should_zoom_in(CAMERA, _obj(), (900, 480, 1020, 600), 0))

    def test_large_object_zooms_out_unless_at_min(self) -> None:
        tracker = self._tracker(0.99)
        self.assertFalse(
            tracker._should_zoom_in(CAMERA, _obj(), (500, 300, 1400, 800), 0)
        )
        tracker.ptz_metrics[CAMERA].zoom_level.value = 0.0
        self.assertIsNone(
            tracker._should_zoom_in(CAMERA, _obj(), (500, 300, 1400, 800), 0)
        )

    def test_predicted_area_and_weight_based_velocity_threshold(self) -> None:
        tracker = self._tracker(
            0.05, weights=WEIGHTS, area_coefficients=np.array([0.0])
        )
        tracker.tracked_object_history[CAMERA].append({"frame_time": 100.0})
        self.assertTrue(
            tracker._should_zoom_in(
                CAMERA, _obj(), (900, 480, 1020, 600), 1.0, debug_zooming=True
            )
        )


class TestZoomAmount(unittest.TestCase):
    def _tracker(self, zooming: str, weights: str | None = None) -> PtzAutoTracker:
        tracker = _tracker(zooming, weights=weights)
        ptz = tracker.ptz_metrics[CAMERA]
        ptz.min_zoom.value = 0.0
        ptz.max_zoom.value = 1.0
        ptz.zoom_level.value = 0.5
        return tracker

    def _metrics(self, tracker: PtzAutoTracker, target_box: float) -> None:
        tracker.tracked_object_metrics[CAMERA].update(
            {
                "target_box": target_box,
                "original_target_box": target_box,
                "area_coefficients": np.array([0.0]),
            }
        )

    def test_disabled_never_zooms(self) -> None:
        tracker = self._tracker("disabled")
        self.assertEqual(
            tracker._get_zoom_amount(CAMERA, _obj(), _obj().obj_data["box"], 0), 0
        )

    def test_absolute_holds_level_on_initial_move(self) -> None:
        tracker = self._tracker("absolute")
        self.assertEqual(
            tracker._get_zoom_amount(CAMERA, _obj(), _obj().obj_data["box"], 0), 0.5
        )

    def test_absolute_steps_in_and_out(self) -> None:
        tracker = self._tracker("absolute")
        self._metrics(tracker, 0.1)
        box = _obj().obj_data["box"]

        with patch.object(tracker, "_should_zoom_in", return_value=True):
            self.assertAlmostEqual(
                tracker._get_zoom_amount(CAMERA, _obj(), box, 0), 0.55
            )
        with patch.object(tracker, "_should_zoom_in", return_value=False):
            self.assertAlmostEqual(
                tracker._get_zoom_amount(CAMERA, _obj(), box, 0), 0.4
            )
        with patch.object(tracker, "_should_zoom_in", return_value=None):
            self.assertEqual(tracker._get_zoom_amount(CAMERA, _obj(), box, 0), 0)

    def test_relative_initial_zoom_from_target_box(self) -> None:
        tracker = self._tracker("relative")
        # small enough that target_box ** zoom_factor stays under the limit
        small = _obj(box=(930, 510, 990, 570))
        expected = (60**2 / (WIDTH * HEIGHT)) ** tracker.zoom_factor[CAMERA]
        self.assertGreater(expected, 0)
        self.assertAlmostEqual(
            tracker._get_zoom_amount(CAMERA, small, small.obj_data["box"], 0),
            expected,
        )

        big = _obj(box=(0, 0, 1900, 1000))
        big_target = (1900**2 / (WIDTH * HEIGHT)) ** tracker.zoom_factor[CAMERA]
        self.assertAlmostEqual(
            tracker._get_zoom_amount(CAMERA, big, big.obj_data["box"], 0),
            -(1 - big_target),
        )

    def test_relative_zoom_in_and_out(self) -> None:
        tracker = self._tracker("relative", weights=WEIGHTS)
        max_box = tracker.tracked_object_metrics[CAMERA]["max_target_box"]
        tracker.tracked_object_history[CAMERA].append({"frame_time": 100.0})
        box = _obj().obj_data["box"]

        # target smaller than the limit: ratio > 1 so zoom is positive
        self._metrics(tracker, max_box / 3)
        with patch.object(tracker, "_should_zoom_in", return_value=True):
            self.assertAlmostEqual(
                tracker._get_zoom_amount(CAMERA, _obj(), box, 1.0), 0.5
            )
        with patch.object(tracker, "_should_zoom_in", return_value=False):
            self.assertAlmostEqual(
                tracker._get_zoom_amount(CAMERA, _obj(), box, 0), -0.5
            )

        # target larger than the limit: ratio < 1 so zoom is negative
        self._metrics(tracker, max_box * 3)
        with patch.object(tracker, "_should_zoom_in", return_value=True):
            self.assertAlmostEqual(
                tracker._get_zoom_amount(CAMERA, _obj(), box, 0), 0.0
            )
        with patch.object(tracker, "_should_zoom_in", return_value=False):
            self.assertAlmostEqual(
                tracker._get_zoom_amount(CAMERA, _obj(), box, 0), 0.0
            )


class TestAutotrackMoves(unittest.TestCase):
    def test_move_ptz_without_weights_centers_on_centroid(self) -> None:
        tracker = _tracker()
        obj = _obj(box=(1400, 100, 1520, 220))

        with patch.object(tracker, "_enqueue_move") as enqueue:
            tracker._autotrack_move_ptz(CAMERA, obj)

        camera, frame_time, pan, tilt, zoom = enqueue.call_args.args
        self.assertEqual((camera, frame_time, zoom), (CAMERA, 100.0, 0))
        self.assertAlmostEqual(pan, (1460 / WIDTH - 0.5) * 2)
        self.assertAlmostEqual(tilt, (0.5 - 160 / HEIGHT) * 2)

    def test_move_ptz_predicts_box_from_velocity(self) -> None:
        tracker = _tracker(weights=WEIGHTS)
        tracker.tracked_object_metrics[CAMERA].update(
            {"valid_velocity": True, "velocity": np.array([10, 0, 10, 0])}
        )
        obj = _obj(box=(900, 480, 1020, 600))

        with patch.object(tracker, "_enqueue_move") as enqueue:
            tracker._autotrack_move_ptz(CAMERA, obj)

        pan = enqueue.call_args.args[2]
        # the predicted centroid is ahead of the current one
        self.assertGreater(pan, (960 / WIDTH - 0.5) * 2)

    def test_move_ptz_relative_zoom_adjusts_for_zoom_time(self) -> None:
        tracker = _tracker("relative", weights=WEIGHTS)
        tracker.tracked_object_metrics[CAMERA].update(
            {"valid_velocity": True, "velocity": np.array([10, 0, 10, 0])}
        )
        obj = _obj(box=(900, 480, 1020, 600))
        pans = []

        for zoom in (0.4, -0.4):
            with (
                patch.object(tracker, "_get_zoom_amount", return_value=zoom),
                patch.object(tracker, "_enqueue_move") as enqueue,
            ):
                tracker._autotrack_move_ptz(CAMERA, obj)
            self.assertEqual(enqueue.call_args.args[4], zoom)
            pans.append(enqueue.call_args.args[2])

        with (
            patch.object(tracker, "_get_zoom_amount", return_value=0),
            patch.object(tracker, "_enqueue_move") as enqueue,
        ):
            tracker._autotrack_move_ptz(CAMERA, obj)
        # the zoom move adds extra predicted travel on top of the pan move
        self.assertGreater(pans[0], enqueue.call_args.args[2])

    def test_move_ptz_relative_zoom_without_velocity(self) -> None:
        tracker = _tracker("relative", weights=WEIGHTS)
        obj = _obj(box=(900, 480, 1020, 600))
        with (
            patch.object(tracker, "_get_zoom_amount", return_value=0.3),
            patch.object(tracker, "_enqueue_move") as enqueue,
        ):
            tracker._autotrack_move_ptz(CAMERA, obj)
        self.assertEqual(enqueue.call_args.args[4], 0.3)

    def test_zoom_only_move(self) -> None:
        tracker = _tracker()
        with patch.object(tracker, "_enqueue_move") as enqueue:
            tracker._autotrack_move_zoom_only(CAMERA, _obj())
        enqueue.assert_not_called()

        tracker = _tracker("absolute")
        for zoom, expected_calls in ((0, 0), (0.6, 1)):
            with (
                patch.object(tracker, "_get_zoom_amount", return_value=zoom),
                patch.object(tracker, "_enqueue_move") as enqueue,
            ):
                tracker._autotrack_move_zoom_only(CAMERA, _obj())
            self.assertEqual(enqueue.call_count, expected_calls)
        enqueue.assert_called_with(CAMERA, 100.0, 0, 0, 0.6)


class TestAutotrackObject(unittest.TestCase):
    def setUp(self) -> None:
        self.tracker = _tracker()
        self.ptz_move = patch.object(self.tracker, "_autotrack_move_ptz").start()
        self.zoom_move = patch.object(self.tracker, "_autotrack_move_zoom_only").start()
        self.addCleanup(patch.stopall)

    def test_unknown_or_disabled_camera_is_ignored(self) -> None:
        self.tracker.autotrack_object("other", _obj(camera="other"))
        self.tracker.config.cameras[CAMERA].onvif.autotracking.enabled = False
        self.tracker.autotrack_object(CAMERA, _obj())

        self.ptz_move.assert_not_called()
        self.assertIsNone(self.tracker.tracked_object[CAMERA])

    def test_sets_up_uninitialized_camera_and_skips_while_calibrating(self) -> None:
        self.tracker.autotracker_init = {}
        self.tracker.calibrating[CAMERA] = True

        with patch.object(
            autotrack_module.asyncio,
            "run_coroutine_threadsafe",
            side_effect=_close_coroutine,
        ) as run:
            self.tracker.autotrack_object(CAMERA, _obj())

        run.assert_called_once()
        self.ptz_move.assert_not_called()

    def test_new_object_starts_tracking(self) -> None:
        obj = _obj()

        self.tracker.autotrack_object(CAMERA, obj)

        self.assertTrue(self.tracker.is_autotracking(CAMERA))
        self.assertIs(self.tracker.tracked_object[CAMERA], obj)
        self.assertTrue(self.tracker.ptz_metrics[CAMERA].tracking_active.is_set())
        self.tracker.dispatcher.publish.assert_called_once_with(
            f"{CAMERA}/ptz_autotracker/active", "ON", retain=False
        )
        self.assertEqual(len(self.tracker.tracked_object_history[CAMERA]), 1)
        self.ptz_move.assert_called_once_with(CAMERA, obj)

    def test_autotracked_object_region_cannot_index_tracked_object(self) -> None:
        # Upstream bug: autotracked_object_region indexes the stored TrackedObject
        # like a dict, but TrackedObject has no __getitem__, so the (currently
        # unused) method raises TypeError instead of returning obj_data["region"]
        self.tracker.tracked_object[CAMERA] = _obj()
        with self.assertRaises(TypeError):
            self.tracker.autotracked_object_region(CAMERA)

    def test_new_object_outside_required_zone_is_ignored(self) -> None:
        self.tracker.autotrack_object(CAMERA, _obj(zones=["other"]))
        self.assertFalse(self.tracker.is_autotracking(CAMERA))

    def test_existing_object_moves_or_zooms(self) -> None:
        first = _obj()
        self.tracker.autotrack_object(CAMERA, first)
        self.ptz_move.reset_mock()

        def metrics(below: bool):
            def side_effect(camera, obj):
                self.tracker.tracked_object_metrics[camera][
                    "below_distance_threshold"
                ] = below

            return side_effect

        with patch.object(
            self.tracker,
            "_calculate_tracked_object_metrics",
            side_effect=metrics(True),
        ):
            self.tracker.autotrack_object(CAMERA, _obj(frame_time=101.0))
        self.zoom_move.assert_called_once()
        self.ptz_move.assert_not_called()

        with patch.object(
            self.tracker,
            "_calculate_tracked_object_metrics",
            side_effect=metrics(False),
        ):
            self.tracker.autotrack_object(CAMERA, _obj(frame_time=102.0))
        self.ptz_move.assert_called_once()

        # a frame received while the ptz is moving neither moves nor zooms
        self.tracker.ptz_metrics[CAMERA].start_time.value = 102.5
        with patch.object(self.tracker, "_calculate_tracked_object_metrics"):
            self.tracker.autotrack_object(CAMERA, _obj(frame_time=103.0))
        self.assertEqual(self.ptz_move.call_count, 1)
        self.assertEqual(self.zoom_move.call_count, 1)
        self.assertEqual(len(self.tracker.tracked_object_history[CAMERA]), 4)

    def test_lost_object_is_reacquired_by_region(self) -> None:
        history = self.tracker.tracked_object_history[CAMERA]
        history.append({"frame_time": 90.0, "region": (0, 0, 1920, 1080)})

        with patch.object(self.tracker, "_calculate_tracked_object_metrics") as calc:
            # a small box inside the large previous region has a low IoU
            new = _obj(obj_id="obj2", box=(900, 480, 1020, 600))
            self.tracker.autotrack_object(CAMERA, new)

        self.assertIs(self.tracker.tracked_object[CAMERA], new)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["id"], "obj2")
        calc.assert_called_once_with(CAMERA, new)
        self.ptz_move.assert_called_once_with(CAMERA, new)

    def test_lost_object_with_high_overlap_is_not_reacquired(self) -> None:
        history = self.tracker.tracked_object_history[CAMERA]
        history.append({"frame_time": 90.0, "region": (900, 480, 1020, 600)})

        self.tracker.autotrack_object(CAMERA, _obj(obj_id="obj2"))

        self.assertIsNone(self.tracker.tracked_object[CAMERA])
        self.ptz_move.assert_not_called()

    def test_end_object_resets_tracking(self) -> None:
        obj = _obj()
        self.tracker.tracked_object[CAMERA] = obj
        self.tracker.tracked_object_metrics[CAMERA]["target_box"] = 0.2

        self.tracker.end_object(CAMERA, _obj(obj_id="other"))
        self.assertIs(self.tracker.tracked_object[CAMERA], obj)

        self.tracker.end_object(CAMERA, obj)
        self.assertIsNone(self.tracker.tracked_object[CAMERA])
        self.assertNotIn("target_box", self.tracker.tracked_object_metrics[CAMERA])
        self.assertIn("max_target_box", self.tracker.tracked_object_metrics[CAMERA])


class TestCameraMaintenance(unittest.IsolatedAsyncioTestCase):
    async def test_skips_while_calibrating_or_tracking(self) -> None:
        tracker = _tracker()
        tracker.ptz_metrics[CAMERA].motor_stopped.clear()
        tracker.calibrating[CAMERA] = True
        await tracker.camera_maintenance(CAMERA)

        tracker.calibrating[CAMERA] = False
        tracker.tracked_object[CAMERA] = _obj()
        await tracker.camera_maintenance(CAMERA)

        tracker.onvif.get_camera_status.assert_not_awaited()

    async def test_polls_status_while_moving(self) -> None:
        tracker = _tracker()
        tracker.ptz_metrics[CAMERA].motor_stopped.clear()

        await tracker.camera_maintenance(CAMERA)

        tracker.onvif.get_camera_status.assert_awaited_once_with(CAMERA)
        tracker.onvif._move_to_preset.assert_not_awaited()

    async def test_waits_for_timeout_before_returning_to_preset(self) -> None:
        tracker = _tracker()
        tracker.tracked_object_history[CAMERA].append({"frame_time": 100.0})
        tracker.ptz_metrics[CAMERA].frame_time.value = 105.0

        await tracker.camera_maintenance(CAMERA)

        tracker.onvif._move_to_preset.assert_not_awaited()
        self.assertEqual(len(tracker.tracked_object_history[CAMERA]), 1)

    async def test_returns_to_preset_after_timeout(self) -> None:
        tracker = _tracker()
        fake = _FakePtz(tracker)
        metrics = tracker.ptz_metrics[CAMERA]
        tracker.tracked_object_history[CAMERA].append({"frame_time": 100.0})
        metrics.frame_time.value = 111.0
        metrics.tracking_active.set()
        metrics.zoom_level.value = 0.7

        async def preset(camera, name):
            await fake.move_to_preset(camera, name)
            metrics.motor_stopped.clear()

        tracker.onvif._move_to_preset.side_effect = preset
        # still moving when maintenance starts: one poll is not enough
        metrics.motor_stopped.clear()
        polls = []

        async def status(camera):
            polls.append(camera)
            if len(polls) > 1:
                metrics.motor_stopped.set()

        tracker.onvif.get_camera_status.side_effect = status

        await tracker.camera_maintenance(CAMERA)
        self.assertGreaterEqual(len(polls), 3)

        tracker.onvif._move_to_preset.assert_awaited_once_with(CAMERA, "home")
        self.assertTrue(metrics.motor_stopped.is_set())
        self.assertEqual(metrics.zoom_level.value, 0.0)
        self.assertEqual(len(tracker.tracked_object_history[CAMERA]), 0)
        self.assertFalse(metrics.tracking_active.is_set())
        self.assertTrue(metrics.reset.is_set())
        tracker.dispatcher.publish.assert_called_once_with(
            f"{CAMERA}/ptz_autotracker/active", "OFF", retain=False
        )


if __name__ == "__main__":
    unittest.main()
