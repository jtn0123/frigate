"""Test inference routing without loading models or downloading weights."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch


class InferenceRoutingTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "audio_infer_test", Path(__file__).with_name("infer.py")
        )
        self.module = importlib.util.module_from_spec(spec)
        # Model kernels are covered by recorded-clip hardware trials. These fakes
        # isolate input limits, VAD gating, and transcription/translation routing.
        dependencies = {
            name: MagicMock()
            for name in (
                "telemetry",
                "ctranslate2",
                "numpy",
                "faster_whisper",
                "faster_whisper.audio",
                "faster_whisper.vad",
            )
        }
        with patch.dict(sys.modules, dependencies):
            spec.loader.exec_module(self.module)
        self.module.resolve_model = Mock(side_effect=lambda name: name)
        self.module.Stage = MagicMock()
        self.module.decode_audio = Mock(return_value=[0] * 16000)
        self.module.get_speech_timestamps = Mock(
            return_value=[{"start": 0, "end": 8000}]
        )
        self.module.classify = Mock(
            return_value=[{"label": "speech", "similarity": 0.2}]
        )
        self.model = self.module.WhisperModel.return_value

    def test_restart_reuses_completed_transcript_and_only_translates(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "checkpoint.json"
            checkpoint.write_text(
                json.dumps(
                    {
                        "model": "medium",
                        "transcript": "preserved",
                        "language": "ar",
                        "stages": {"transcription": {"status": "complete"}},
                        "translation": "",
                        "sounds": [],
                    }
                )
            )
            self.model.transcribe.return_value = (
                [SimpleNamespace(text="translated")],
                SimpleNamespace(language="ar"),
            )
            result = self.module.analyze("clip.wav", "medium", str(checkpoint))
            self.assertEqual(result["transcript"], "preserved")
            self.assertEqual(result["translation"], "translated")
            self.model.transcribe.assert_called_once()
            self.assertEqual(
                self.model.transcribe.call_args.kwargs["task"], "translate"
            )

    def test_cli_checkpoint_rejects_paths_outside_worker_state(self):
        import argparse

        with self.assertRaises(argparse.ArgumentTypeError):
            self.module.checkpoint_argument("/etc/passwd")
        self.assertEqual(
            self.module.checkpoint_argument("/state/checkpoints/job/medium.json"),
            "/state/checkpoints/job/medium.json",
        )

    def test_silence_skips_whisper_but_still_classifies_sounds(self):
        self.module.get_speech_timestamps.return_value = []
        result = self.module.analyze("clip.wav", "medium")
        self.module.WhisperModel.assert_not_called()
        self.module.classify.assert_called_once_with("clip.wav")
        self.assertEqual(result["transcript"], "")
        self.assertFalse(result["sound_scores_are_probabilities"])

    def test_english_reuses_transcript_without_second_translation(self):
        self.model.transcribe.return_value = (
            [SimpleNamespace(text=" hello ")],
            SimpleNamespace(language="en"),
        )
        result = self.module.analyze("clip.wav", "medium")
        self.assertEqual(result["transcript"], "hello")
        self.assertEqual(result["translation"], "hello")
        self.model.transcribe.assert_called_once()
        self.assertTrue(self.module.WhisperModel.call_args.kwargs["local_files_only"])
        self.assertEqual(self.module.WhisperModel.call_args.kwargs["device"], "cpu")

    def test_foreign_speech_preserves_original_and_requests_translation(self):
        self.model.transcribe.side_effect = [
            ([SimpleNamespace(text="original")], SimpleNamespace(language="ar")),
            ([SimpleNamespace(text="English")], SimpleNamespace(language="ar")),
        ]
        result = self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(result["transcript"], "original")
        self.assertEqual(result["translation"], "English")
        self.assertEqual(self.model.transcribe.call_args.kwargs["task"], "translate")
        self.assertEqual(self.model.transcribe.call_args.kwargs["language"], "ar")
        self.module.classify.assert_not_called()

    def test_completed_transcript_is_checkpointed_before_sound_stage(self):
        self.model.transcribe.return_value = (
            [SimpleNamespace(text="preserved")],
            SimpleNamespace(language="en"),
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"

            def interrupted(_):
                self.assertEqual(
                    json.loads(path.read_text())["transcript"], "preserved"
                )
                raise KeyboardInterrupt()

            self.module.classify.side_effect = interrupted
            with self.assertRaises(KeyboardInterrupt):
                self.module.analyze("clip.wav", "medium", str(path))
            self.assertEqual(json.loads(path.read_text())["transcript"], "preserved")

    def test_sound_failure_preserves_completed_transcript(self):
        self.model.transcribe.return_value = (
            [SimpleNamespace(text="hello")],
            SimpleNamespace(language="en"),
        )
        self.module.classify.side_effect = OSError("broken model")
        result = self.module.analyze("clip.wav", "medium")
        self.assertEqual(result["transcript"], "hello")
        self.assertEqual(result["stages"]["sounds"]["status"], "failed")
        self.model.transcribe.assert_called_once()
        self.assertEqual(self.module.classify.call_count, 2)

    def test_translation_failure_preserves_original_and_sounds(self):
        self.model.transcribe.side_effect = [
            ([SimpleNamespace(text="original")], SimpleNamespace(language="ar")),
            RuntimeError("translation unavailable"),
            RuntimeError("unavailable"),
        ]
        result = self.module.analyze("clip.wav", "medium")
        self.assertEqual(result["transcript"], "original")
        self.assertEqual(result["translation"], "")
        self.assertEqual(result["stages"]["translation"]["status"], "failed")
        self.assertEqual(len(result["sounds"]), 1)

    def test_empty_and_oversized_clips_rejected_before_loading_models(self):
        for audio in ([], [0] * (35 * 16000 + 1)):
            self.module.decode_audio.return_value = audio
            with self.assertRaises(ValueError):
                self.module.analyze("clip.wav", "medium")
        self.module.WhisperModel.assert_not_called()
        self.module.classify.assert_not_called()
