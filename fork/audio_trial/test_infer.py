"""Test inference routing without loading models or downloading weights."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import hallucination


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

    def test_cli_job_key_rejects_paths_and_nonhex_identifiers(self):
        import argparse

        for value in ("/etc/passwd", "../state", "x" * 64, "a" * 65):
            with self.assertRaises(argparse.ArgumentTypeError):
                self.module.job_key_argument(value)
        self.assertEqual(self.module.job_key_argument("0" * 63 + "f"), 15)

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


def segment(text, no_speech_prob=0.1, avg_logprob=-0.3, compression_ratio=1.2):
    """Build one decoded segment with the statistics faster-whisper reports."""
    return SimpleNamespace(
        text=text,
        no_speech_prob=no_speech_prob,
        avg_logprob=avg_logprob,
        compression_ratio=compression_ratio,
    )


# The three Large-v3 second opinions taken on the owner's server in one week,
# each a subtitle credit or filler decoded from near-silent audio.
JAPANESE_CREDIT = segment("ご視聴ありがとうございました")
RUSSIAN_CREDIT = segment("Субтитры сделал DimaTorzok")
LOW_CONFIDENCE_FILLER = segment("No, no.", no_speech_prob=0.82, avg_logprob=-1.4)
GENUINE_ENGLISH = segment("Hello, I have a package for you.")


class HallucinationGuardTests(unittest.TestCase):
    """Reject known Whisper hallucinations instead of storing them as speech."""

    # Reuse the fake faster-whisper wiring without rerunning the routing tests.
    setUp = InferenceRoutingTests.setUp

    def test_second_opinion_forces_the_configured_language(self):
        self.model.transcribe.return_value = (
            [GENUINE_ENGLISH],
            SimpleNamespace(language="en", language_probability=0.99),
        )
        self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(self.model.transcribe.call_args.kwargs["language"], "en")
        with patch.dict("os.environ", {"AUDIO_TRIAL_LANGUAGE": "de"}):
            self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(self.model.transcribe.call_args.kwargs["language"], "de")

    def test_medium_pass_keeps_automatic_language_detection(self):
        self.model.transcribe.return_value = (
            [GENUINE_ENGLISH],
            SimpleNamespace(language="en", language_probability=0.99),
        )
        self.module.analyze("clip.wav", "medium")
        self.assertIsNone(self.model.transcribe.call_args.kwargs["language"])

    def test_japanese_subtitle_credit_leaves_no_transcript(self):
        self.model.transcribe.return_value = (
            [JAPANESE_CREDIT],
            SimpleNamespace(language="ja", language_probability=0.91),
        )
        result = self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(result["transcript"], "")
        self.assertIn(
            "known hallucination phrase", result["rejected_segments"][0]["reason"]
        )

    def test_russian_subtitle_credit_leaves_no_transcript(self):
        self.model.transcribe.return_value = (
            [RUSSIAN_CREDIT],
            SimpleNamespace(language="ru", language_probability=0.88),
        )
        result = self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(result["transcript"], "")
        self.assertIn("dimatorzok", result["rejected_segments"][0]["reason"])

    def test_low_confidence_filler_is_dropped_by_whisper_statistics(self):
        self.model.transcribe.return_value = (
            [LOW_CONFIDENCE_FILLER],
            SimpleNamespace(language="en", language_probability=0.64),
        )
        result = self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(result["transcript"], "")
        self.assertIn("no speech probability", result["rejected_segments"][0]["reason"])

    def test_repetitive_segment_is_dropped_by_compression_ratio(self):
        self.model.transcribe.return_value = (
            [segment("go go go go go go go go", compression_ratio=3.1)],
            SimpleNamespace(language="en", language_probability=0.9),
        )
        result = self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(result["transcript"], "")
        self.assertIn("compression ratio", result["rejected_segments"][0]["reason"])

    def test_genuine_english_speech_passes_through_untouched(self):
        self.model.transcribe.return_value = (
            [GENUINE_ENGLISH],
            SimpleNamespace(language="en", language_probability=0.99),
        )
        result = self.module.analyze("clip.wav", "large-v3")
        self.assertEqual(result["transcript"], "Hello, I have a package for you.")
        self.assertEqual(result["translation"], result["transcript"])
        self.assertEqual(result["rejected_segments"], [])
        self.assertEqual(result["language_probability"], 0.99)


class SecondOpinionRejectionTests(unittest.TestCase):
    """Compare a Large second opinion against the Medium pass that asked for it."""

    def setUp(self):
        self.medium = {
            "transcript": "",
            "language": "nn",
            "language_probability": 0.42,
            "speech_seconds": 3,
        }

    def test_detected_language_must_match_the_configured_language(self):
        rejection = hallucination.second_opinion_rejection(
            self.medium, {"transcript": "ありがとう", "language": "ja"}
        )
        self.assertEqual(rejection, "language ja differs from en")

    def test_confident_medium_language_sets_the_expectation(self):
        medium = {
            "transcript": "hello there",
            "language": "en",
            "language_probability": 0.97,
        }
        self.assertEqual(
            hallucination.second_opinion_rejection(
                medium, {"transcript": "Subtitles by DimaTorzok", "language": "ru"}
            ),
            "language ru differs from en",
        )

    def test_empty_second_opinion_reports_why_its_segments_were_dropped(self):
        rejection = hallucination.second_opinion_rejection(
            self.medium,
            {
                "transcript": "",
                "language": "en",
                "rejected_segments": [
                    {
                        "text": "No, no.",
                        "reason": "no speech probability above threshold",
                    }
                ],
            },
        )
        self.assertEqual(rejection, "no speech probability above threshold")

    def test_credit_phrase_in_english_is_rejected(self):
        self.assertIn(
            "please subscribe",
            hallucination.second_opinion_rejection(
                self.medium,
                {"transcript": "Thank you, please subscribe.", "language": "en"},
            ),
        )

    def test_genuine_english_second_opinion_is_accepted(self):
        self.assertIsNone(
            hallucination.second_opinion_rejection(
                self.medium,
                {"transcript": "Hello, I have a package for you.", "language": "en"},
            )
        )
