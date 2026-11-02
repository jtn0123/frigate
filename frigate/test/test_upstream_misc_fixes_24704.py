"""B43: single fixes ported from upstream #24704 that upstream left untested."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from playhouse.sqlite_ext import SqliteExtDatabase
from pydantic import ValidationError

from frigate.comms.dispatcher import Dispatcher
from frigate.config import FrigateConfig
from frigate.config.camera.record import RecordConfig
from frigate.const import UPDATE_EVENT_DESCRIPTION
from frigate.data_processing.post.audio_transcription import (
    AudioTranscriptionPostProcessor,
)
from frigate.models import Event
from frigate.track.object_processing import TrackedObjectProcessor

CERTSYNC_RUN = (
    Path(__file__).resolve().parents[2]
    / "docker/main/rootfs/etc/s6-overlay/s6-rc.d/certsync/run"
)


class TestRecordExpireInterval(unittest.TestCase):
    def test_expire_interval_below_one_is_rejected(self):
        # a zero interval made the cleanup loop exit at startup
        for interval in (0, -5):
            with self.assertRaises(ValidationError):
                RecordConfig(expire_interval=interval)

        self.assertEqual(RecordConfig(expire_interval=1).expire_interval, 1)


class TestTranscriptionTempWav(unittest.TestCase):
    def test_temp_wav_is_removed_when_whisper_raises(self):
        processor = AudioTranscriptionPostProcessor.__new__(
            AudioTranscriptionPostProcessor
        )
        processor.recognizer = MagicMock()
        processor.recognizer.transcribe.side_effect = RuntimeError("whisper failed")

        with tempfile.TemporaryDirectory() as cache_dir:
            with (
                patch(
                    "frigate.data_processing.post.audio_transcription.CACHE_DIR",
                    cache_dir,
                ),
                self.assertLogs(
                    "frigate.data_processing.post.audio_transcription", "ERROR"
                ),
            ):
                result = processor._AudioTranscriptionPostProcessor__transcribe_audio_whisper(
                    b"RIFF"
                )

            self.assertIsNone(result)
            self.assertEqual(os.listdir(cache_dir), [])


class TestDescriptionForDeletedEvent(unittest.TestCase):
    def setUp(self):
        self.database = SqliteExtDatabase(":memory:")
        bind = self.database.bind_ctx([Event])
        bind.__enter__()
        self.addCleanup(bind.__exit__, None, None, None)
        self.addCleanup(self.database.close)
        self.database.create_tables([Event])

    def test_missing_event_is_skipped(self):
        communicator = MagicMock()

        with (
            patch("frigate.comms.dispatcher.CameraActivityManager"),
            patch("frigate.comms.dispatcher.AudioActivityManager"),
        ):
            dispatcher = Dispatcher(
                MagicMock(), MagicMock(), MagicMock(), {}, [communicator]
            )

        communicator.publish.reset_mock()
        # the event was deleted before its GenAI description finished
        dispatcher._receive(
            UPDATE_EVENT_DESCRIPTION, {"id": "gone", "description": "a person"}
        )

        communicator.publish.assert_not_called()


class TestBirdseyeFrameShape(unittest.TestCase):
    def _processor(self, birdseye: dict) -> tuple[TrackedObjectProcessor, MagicMock]:
        config = FrigateConfig(
            mqtt={"enabled": False},
            birdseye=birdseye,
            cameras={
                "front": {
                    "ffmpeg": {
                        "inputs": [{"path": "rtsp://test/front", "roles": ["detect"]}]
                    },
                    "detect": {"width": 320, "height": 240},
                }
            },
        )
        frames = MagicMock()
        module = "frigate.track.object_processing"

        with (
            patch(f"{module}.SharedMemoryFrameManager", return_value=frames),
            patch(f"{module}.CameraConfigUpdateSubscriber"),
            patch(f"{module}.InterProcessRequestor"),
            patch(f"{module}.DetectionPublisher"),
            patch(f"{module}.EventUpdatePublisher"),
            patch(f"{module}.EventEndSubscriber"),
            patch(f"{module}.EventMetadataSubscriber"),
        ):
            processor = TrackedObjectProcessor(
                config, MagicMock(), MagicMock(), MagicMock(), MagicMock()
            )

        return processor, frames

    def test_reads_birdseye_with_the_snapped_canvas_shape(self):
        # 1920x1200 is not a supported aspect ratio, so the writer snaps it
        # to 1920x1308 (22:15)
        processor, frames = self._processor(
            {"enabled": True, "restream": True, "width": 1920, "height": 1200}
        )

        processor.get_current_frame("birdseye")

        frames.get.assert_called_once_with("birdseye", (1962, 1920))

    def test_birdseye_without_restream_has_no_frame(self):
        processor, frames = self._processor({"enabled": True, "restream": False})

        self.assertIsNone(processor.get_current_frame("birdseye"))
        frames.get.assert_not_called()


class TestCertsyncProbe(unittest.TestCase):
    def test_tls_probe_sends_no_request_after_the_handshake(self):
        # echo piped a newline to nginx, which logged an empty 400 request
        script = CERTSYNC_RUN.read_text()

        self.assertNotIn("echo | openssl s_client", script)
        self.assertIn("</dev/null", script)


if __name__ == "__main__":
    unittest.main()
