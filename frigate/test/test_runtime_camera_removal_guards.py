"""Guards for data that still names a camera after it was removed at runtime (D58).

A camera deleted from the config can keep showing up for a moment in frames,
detections and notifications that were already queued. Each consumer below
must drop that data instead of raising a KeyError."""

import datetime
import json
import multiprocessing as mp
import threading
import unittest
from collections import defaultdict
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np

from frigate.app import FrigateApp
from frigate.comms.detections_updater import DetectionTypeEnum
from frigate.comms.webpush import WebPushClient
from frigate.config import BirdseyeModeEnum, FrigateConfig
from frigate.output.birdseye import BirdsEyeFrameManager
from frigate.output.output import OutputProcess, check_disabled_camera_update
from frigate.record.maintainer import RecordingMaintainer
from frigate.util.ffmpeg import start_or_restart_ffmpeg


def _config(**camera_overrides) -> FrigateConfig:
    camera = {
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
        },
        "detect": {"height": 720, "width": 1280, "fps": 5},
    }
    camera.update(camera_overrides)
    return FrigateConfig(
        mqtt={"enabled": False},
        birdseye={"enabled": True, "mode": "continuous"},
        cameras={"front": camera},
    )


class TestCheckDisabledCameraUpdate(unittest.TestCase):
    def test_removed_camera_is_skipped(self):
        birdseye = MagicMock()
        previews = {"front": MagicMock()}

        # "gone" was removed from the config but still has a write time; long
        # offline cameras get no blank frame, so nothing is written at all
        check_disabled_camera_update(
            _config(), birdseye, previews, {"gone": 0.0, "front": 0.0}
        )

        birdseye.write_data.assert_not_called()
        # the remaining configured camera is enabled
        birdseye.all_cameras_disabled.assert_not_called()

    def test_only_removed_cameras_counts_as_all_disabled(self):
        birdseye = MagicMock()

        check_disabled_camera_update(_config(), birdseye, {}, {"gone": 0.0})

        birdseye.all_cameras_disabled.assert_called_once()

    def test_recently_offline_camera_gets_a_blank_frame(self):
        birdseye = MagicMock()
        now = datetime.datetime.now().timestamp()

        check_disabled_camera_update(
            _config(), birdseye, {}, {"gone": now - 5, "front": now - 5}
        )

        self.assertEqual(
            [c.args[0] for c in birdseye.write_data.call_args_list], ["front"]
        )
        frame = birdseye.write_data.call_args.args[4]
        self.assertEqual(frame.shape, (720 * 3 // 2, 1280))

    def test_disabled_camera_is_flagged_offline(self):
        previews = {"front": MagicMock()}

        check_disabled_camera_update(
            _config(enabled=False), None, previews, {"front": 0.0}
        )

        previews["front"].flag_offline.assert_called_once()


class TestOutputProcessShutdownDrain(unittest.TestCase):
    def test_leftover_frames_of_removed_cameras_are_skipped(self):
        config = _config()
        config.birdseye.enabled = False
        stop_event = mp.Event()
        stop_event.set()
        process = OutputProcess(config, stop_event)

        video = DetectionTypeEnum.video.value
        detections = MagicMock()
        # frames still queued at shutdown, one from a camera removed meanwhile
        detections.check_for_update.side_effect = [
            (video, ("gone", "gone_frame", 1.0, [], [], [])),
            (video, ("front", "front_frame", 2.0, [], [], [])),
            None,
        ]

        with (
            patch.object(process, "pre_run_setup"),
            patch.object(process, "add_camera"),
            patch("frigate.output.output.make_server"),
            patch("frigate.output.output.move_preview_frames"),
            patch("frigate.output.output.ConfigSubscriber"),
            patch("frigate.output.output.CameraConfigUpdateSubscriber"),
            patch("frigate.output.output.DetectionSubscriber", return_value=detections),
            patch("frigate.output.output.SharedMemoryFrameManager") as frames,
        ):
            process.run()

        frame_manager = frames.return_value
        frame_manager.get.assert_called_once_with(
            "front_frame", config.cameras["front"].frame_shape_yuv
        )
        frame_manager.close.assert_called_once_with("front_frame")
        detections.stop.assert_called_once()


class TestBirdseyeUpdate(unittest.TestCase):
    def setUp(self):
        self.config = _config()
        self.manager = BirdsEyeFrameManager(self.config, mp.Event())
        self.frame = np.zeros((720 * 3 // 2, 1280), np.uint8)

    def test_camera_without_birdseye_state_is_ignored(self):
        # the config update can land before birdseye builds the camera's state
        self.manager.cameras.pop("front")

        self.assertEqual(
            self.manager.update("front", 0, 0, 1.0, self.frame), (False, False)
        )

    def test_unknown_camera_is_ignored(self):
        self.assertEqual(
            self.manager.update("gone", 0, 0, 1.0, self.frame), (False, False)
        )

    def test_active_camera_stores_the_frame(self):
        self.manager.update_frame = MagicMock(return_value=(True, False))

        self.assertEqual(
            self.manager.update("front", 1, 0, 5.0, self.frame), (True, False)
        )
        state = self.manager.cameras["front"]
        self.assertEqual(state["current_frame_time"], 5.0)
        self.assertEqual(state["last_active_frame"], 5.0)
        self.assertIsNot(state["current_frame"], self.frame)

    def test_disabling_birdseye_forces_one_blank_update(self):
        self.manager.update_frame = MagicMock(return_value=(False, False))
        self.manager.cameras["front"]["last_active_frame"] = 3.0
        self.config.cameras["front"].birdseye.enabled = False
        # with no objects the camera does not count as active again
        self.config.cameras["front"].birdseye.mode = BirdseyeModeEnum.objects

        frame_changed, _ = self.manager.update("front", 0, 0, 5.0, self.frame)

        self.assertTrue(frame_changed)
        self.assertEqual(self.manager.cameras["front"]["last_active_frame"], 0)
        # nothing was rendered since, so later frames are dropped
        self.assertEqual(
            self.manager.update("front", 0, 0, 6.0, self.frame), (False, False)
        )


class TestWebPushRemovedCamera(unittest.TestCase):
    def setUp(self):
        self.client = WebPushClient.__new__(WebPushClient)
        self.client.config = SimpleNamespace(
            cameras={
                "front": SimpleNamespace(
                    notifications=SimpleNamespace(enabled=True),
                    semantic_search=SimpleNamespace(
                        triggers={"red_car": SimpleNamespace(actions=["notification"])}
                    ),
                )
            }
        )
        self.client.global_config_subscriber = MagicMock()
        self.client.global_config_subscriber.check_for_update.return_value = (
            None,
            None,
        )
        self.client.config_subscriber = MagicMock()
        self.client.config_subscriber.check_for_updates.return_value = {}
        self.client.is_camera_suspended = MagicMock(return_value=False)
        self.client.send_alert = MagicMock()
        self.client.send_trigger = MagicMock()
        self.client.send_camera_monitoring = MagicMock()

    def test_review_for_removed_camera_is_dropped(self):
        self.client.publish("reviews", json.dumps({"before": {"camera": "gone"}}))
        self.client.send_alert.assert_not_called()

        self.client.publish("reviews", json.dumps({"before": {"camera": "front"}}))
        self.client.send_alert.assert_called_once()

    def test_trigger_for_removed_camera_is_dropped(self):
        self.client.publish(
            "triggers", json.dumps({"camera": "gone", "name": "red_car"})
        )
        self.client.send_trigger.assert_not_called()

        self.client.publish(
            "triggers", json.dumps({"camera": "front", "name": "red_car"})
        )
        self.client.send_trigger.assert_called_once()

    def test_camera_monitoring_for_removed_camera_is_dropped(self):
        self.client.publish("camera_monitoring", json.dumps({"camera": "gone"}))
        self.client.send_camera_monitoring.assert_not_called()

        self.client.publish("camera_monitoring", json.dumps({"camera": "front"}))
        self.client.send_camera_monitoring.assert_called_once()


class TestRecordingMaintainerRemovedCamera(unittest.TestCase):
    def test_detections_for_removed_camera_are_not_buffered(self):
        maintainer = RecordingMaintainer.__new__(RecordingMaintainer)
        maintainer.config = _config(record={"enabled": True})
        maintainer.object_recordings_info = defaultdict(list)
        maintainer.audio_recordings_info = defaultdict(list)
        maintainer.config_subscriber = MagicMock()
        maintainer.requestor = MagicMock()
        maintainer.recordings_publisher = MagicMock()
        maintainer.move_files = AsyncMock()

        video = DetectionTypeEnum.video.value
        audio = DetectionTypeEnum.audio.value
        maintainer.detection_subscriber = MagicMock()
        maintainer.detection_subscriber.check_for_update.side_effect = [
            (video, ("gone", None, 1.0, [], [], [])),
            (video, ("front", None, 2.0, ["obj"], [], [])),
            (audio, ("gone", 3.0, -40, [])),
            (audio, ("front", 4.0, -30, [("bark", 0.9)])),
            None,
        ]
        # one pass of the loop, then stop
        maintainer.stop_event = MagicMock()
        maintainer.stop_event.is_set.side_effect = [False, False, True]

        with patch("frigate.record.maintainer.time.sleep"):
            maintainer.run()

        self.assertEqual(
            dict(maintainer.object_recordings_info), {"front": [(2.0, ["obj"], [], [])]}
        )
        self.assertEqual(
            dict(maintainer.audio_recordings_info),
            {"front": [(4.0, -30, [("bark", 0.9)])]},
        )
        maintainer.move_files.assert_awaited_once()


class TestAudioProcessorWiring(unittest.TestCase):
    def _app(self) -> FrigateApp:
        app = FrigateApp.__new__(FrigateApp)
        app.config_holder = SimpleNamespace(config=MagicMock())
        app.camera_metrics = MagicMock()
        app.embeddings_metrics = MagicMock()
        app.stop_event = threading.Event()
        app.detectors = {}
        app.processes = {}
        return app

    def test_start_audio_processor_passes_embeddings_metrics(self):
        app = self._app()

        with patch("frigate.app.AudioProcessor") as processor:
            processor.return_value.pid = 42
            app.start_audio_processor()

        processor.assert_called_once_with(
            app.config, app.camera_metrics, app.embeddings_metrics, app.stop_event
        )
        self.assertEqual(app.processes["audio_detector"], 42)

    def test_watchdog_restarts_the_audio_processor(self):
        app = self._app()
        app.audio_process = MagicMock(pid=7)
        # a process that was never started is not registered
        app.embedding_process = None

        with patch("frigate.app.FrigateWatchdog") as watchdog_cls:
            app.start_watchdog()

        watchdog = watchdog_cls.return_value
        self.assertEqual(
            [c.args[0] for c in watchdog.register.call_args_list], ["audio_detector"]
        )
        _, process, factory, on_restart = watchdog.register.call_args.args
        self.assertIs(process, app.audio_process)

        with patch("frigate.app.AudioProcessor") as processor:
            restarted = factory()
        processor.assert_called_once_with(
            app.config, app.camera_metrics, app.embeddings_metrics, app.stop_event
        )

        restarted.pid = 99
        on_restart(restarted)
        self.assertIs(app.audio_process, restarted)
        self.assertEqual(app.processes["audio_detector"], 99)
        watchdog.start.assert_called_once()


class TestStartOrRestartFfmpeg(unittest.TestCase):
    def test_restart_flushes_the_log_after_stopping(self):
        order = []
        logpipe = MagicMock()
        logpipe.dump.side_effect = lambda: order.append("dump")
        old = MagicMock()

        with (
            patch(
                "frigate.util.ffmpeg.stop_ffmpeg",
                side_effect=lambda *_: order.append("stop"),
            ),
            patch("frigate.util.ffmpeg.sp.Popen") as popen,
        ):
            process = start_or_restart_ffmpeg(
                ["ffmpeg"], MagicMock(), logpipe, ffmpeg_process=old
            )

        self.assertEqual(order, ["stop", "dump"])
        self.assertIs(process, popen.return_value)

    def test_first_start_does_not_flush(self):
        logpipe = MagicMock()

        with patch("frigate.util.ffmpeg.sp.Popen"):
            start_or_restart_ffmpeg(["ffmpeg"], MagicMock(), logpipe, frame_size=10)

        logpipe.dump.assert_not_called()


if __name__ == "__main__":
    unittest.main()
