"""Audio maintainers hold their camera's metrics object (D54).

The maintainer used to index the camera_metrics manager dict on every chunk,
which broke once the camera maintainer popped the entry for a removed camera.
The transcription processor gets the embeddings metrics it reports into."""

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.config import FrigateConfig
from frigate.events.audio import AudioEventMaintainer, AudioProcessor


def _config(transcription: bool = False) -> FrigateConfig:
    return FrigateConfig(
        mqtt={"enabled": False},
        audio_transcription={"enabled": transcription},
        cameras={
            "front_door": {
                "ffmpeg": {
                    "inputs": [
                        {
                            "path": "rtsp://10.0.0.1:554/video",
                            "roles": ["detect", "audio"],
                        }
                    ]
                },
                "detect": {"height": 720, "width": 1280, "fps": 5},
                "audio": {"enabled": True, "min_volume": 500},
                "audio_transcription": {"enabled": transcription},
            }
        },
    )


def _metrics():
    return SimpleNamespace(
        audio_rms=SimpleNamespace(value=0.0),
        audio_dBFS=SimpleNamespace(value=0.0),
    )


class TestAudioProcessor(unittest.TestCase):
    def test_keeps_the_embeddings_metrics(self):
        embeddings_metrics = MagicMock()

        processor = AudioProcessor(_config(), {}, embeddings_metrics, threading.Event())

        self.assertIs(processor.embeddings_metrics, embeddings_metrics)

    def test_skips_camera_with_audio_disabled(self):
        config = _config()
        config.cameras["front_door"].audio.enabled = False
        processor = AudioProcessor(
            config, {"front_door": _metrics()}, MagicMock(), threading.Event()
        )
        processor.audio_threads = {}

        with patch("frigate.events.audio.AudioEventMaintainer") as maintainer:
            processor.spawn_if_needed(config.cameras["front_door"])

        maintainer.assert_not_called()

    def test_run_spawns_and_stops_maintainers_as_cameras_change(self):
        config = _config()
        config.cameras["back_yard"] = config.cameras["front_door"].model_copy(
            update={"name": "back_yard"}
        )
        front_metrics = _metrics()
        back_metrics = _metrics()
        # back_yard's metrics are created by the camera maintainer later
        camera_metrics = {"front_door": front_metrics}
        stop_event = MagicMock()
        # one poll of the config updates, then stop
        stop_event.wait.side_effect = [False, True]
        processor = AudioProcessor(config, camera_metrics, MagicMock(), stop_event)
        processor.logger = MagicMock()

        def poll():
            config.cameras.pop("front_door")
            camera_metrics["back_yard"] = back_metrics
            return {"remove": ["front_door"]}

        subscriber = MagicMock()
        subscriber.check_for_updates.side_effect = poll
        thread_name = threading.current_thread().name

        try:
            with (
                patch.object(processor, "pre_run_setup"),
                patch(
                    "frigate.events.audio.CameraConfigUpdateSubscriber",
                    return_value=subscriber,
                ),
                patch("frigate.events.audio.AudioEventMaintainer") as maintainer,
            ):
                maintainer.return_value.is_alive.return_value = False
                processor.run()
        finally:
            threading.current_thread().name = thread_name

        # front_door at startup, back_yard on the poll once its metrics exist,
        # each with its own metrics object
        self.assertEqual(
            [c.args[2] for c in maintainer.call_args_list],
            [front_metrics, back_metrics],
        )
        # front_door was torn down when it was removed
        maintainer.return_value.stop.assert_called_once()
        self.assertEqual(list(processor.audio_threads), ["back_yard"])
        self.assertIsNone(processor.transcription_model_runner)
        subscriber.stop.assert_called_once()


class TestAudioEventMaintainer(unittest.TestCase):
    def _maintainer(self, config, metrics, embeddings_metrics, runner=None):
        with (
            patch("frigate.events.audio.AudioTfl"),
            patch("frigate.events.audio.LogPipe"),
            patch("frigate.events.audio.InterProcessRequestor"),
            patch("frigate.events.audio.CameraConfigUpdateSubscriber"),
            patch("frigate.events.audio.DetectionPublisher"),
            patch(
                "frigate.events.audio.AudioTranscriptionRealTimeProcessor"
            ) as transcription,
        ):
            maintainer = AudioEventMaintainer(
                config.cameras["front_door"],
                config,
                metrics,
                embeddings_metrics,
                runner,
                threading.Event(),
            )
        return maintainer, transcription

    def test_transcription_reports_into_the_embeddings_metrics(self):
        config = _config(transcription=True)
        embeddings_metrics = MagicMock()

        maintainer, transcription = self._maintainer(
            config, _metrics(), embeddings_metrics, runner=MagicMock()
        )
        maintainer.transcription_thread.join(1)

        self.assertIs(transcription.call_args.kwargs["metrics"], embeddings_metrics)

    def test_detect_audio_writes_levels_to_the_held_metrics(self):
        config = _config()
        metrics = _metrics()
        maintainer, _ = self._maintainer(config, metrics, MagicMock())

        # quiet audio: levels are recorded, the model is not run
        audio = np.full(maintainer.shape, 100, dtype=np.int16)
        maintainer.detect_audio(audio)

        self.assertAlmostEqual(metrics.audio_rms.value, 100.0)
        self.assertLess(metrics.audio_dBFS.value, 0)
        maintainer.detector.detect.assert_not_called()
        maintainer.requestor.send_data.assert_any_call(
            "update_audio_activity", {"front_door": {"detections": []}}
        )


if __name__ == "__main__":
    unittest.main()
