"""Keep annotated review requests and transcription role metadata consistent."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frigate import genai
from frigate.config.camera.genai import GenAIRoleEnum
from frigate.genai.manager import GenAIClientManager


class TestDescriptionRequest(unittest.TestCase):
    def test_captions_and_style_reach_the_provider_and_debug_files(self):
        client = object.__new__(genai.GenAIClient)
        response = json.dumps(
            {
                "title": "visitor arrives",
                "scene": "A visitor arrives",
                "shortSummary": "Visitor",
                "potential_threat_level": 0,
                "observations": [],
                "confidence": 0.9,
            }
        )
        data = {"id": "review1", "camera": "front", "unified_objects": [], "start": 100}
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(genai, "CLIPS_DIR", directory),
            patch.object(
                genai, "build_review_description_prompt", return_value="styled prompt"
            ) as prompt,
            patch.object(client, "_send", return_value=response) as send,
        ):
            debug = Path(directory) / "genai-requests/review1"
            debug.mkdir(parents=True)
            result = client.generate_review_description(
                data,
                [b"frame"],
                [],
                "en",
                True,
                "context",
                response_style="concise",
                frame_captions=["Frame one"],
            )
            self.assertIsNotNone(result)
            self.assertEqual(result.title, "Visitor arrives")
            self.assertEqual(prompt.call_args.args[-2:], ("concise", ["Frame one"]))
            self.assertEqual(send.call_args.kwargs["image_captions"], ["Frame one"])
            self.assertEqual((debug / "0.txt").read_text(), "Frame one")
            self.assertEqual((debug / "prompt.txt").read_text(), "styled prompt")
            self.assertEqual((debug / "response.txt").read_text(), response)

    def test_mismatched_captions_fall_back_to_plain_images(self):
        client = object.__new__(genai.GenAIClient)
        with (
            patch.object(
                genai, "build_review_description_prompt", return_value="plain prompt"
            ) as prompt,
            patch.object(client, "_send", return_value=None) as send,
            self.assertLogs(genai.logger, level="WARNING"),
        ):
            result = client.generate_review_description(
                {"id": "review1", "camera": "front"},
                [b"one", b"two"],
                [],
                None,
                False,
                "context",
                frame_captions=["Only one"],
            )
        self.assertIsNone(result)
        self.assertIsNone(prompt.call_args.args[-1])
        self.assertIsNone(send.call_args.kwargs["image_captions"])
        self.assertEqual(send.call_args.args[1], [b"one", b"two"])


class TestTranscriptionRoleMetadata(unittest.TestCase):
    def setUp(self):
        self.manager = object.__new__(GenAIClientManager)
        self.manager._role_map = {
            GenAIRoleEnum.transcribe: "speech",
            GenAIRoleEnum.descriptions: "vision",
            GenAIRoleEnum.chat: "offline",
        }
        self.manager._configs = {
            name: SimpleNamespace(model=f"{name}-model")
            for name in ("speech", "vision", "offline")
        }
        self.speech = Mock()
        self.speech.get_context_size.return_value = 8192
        self.vision = Mock()
        self.vision.get_context_size.return_value = 64000

    def test_role_metadata_reports_configured_models_without_listing_remote_catalogs(
        self,
    ):
        clients = {"speech": self.speech, "vision": self.vision, "offline": None}
        with patch.object(self.manager, "_get_client", side_effect=clients.get):
            self.assertIs(self.manager.transcribe_client, self.speech)
            self.assertEqual(
                self.manager.role_info(),
                {
                    "transcribe": {
                        "name": "speech",
                        "model": "speech-model",
                        "context_size": 8192,
                    },
                    "descriptions": {
                        "name": "vision",
                        "model": "vision-model",
                        "context_size": 64000,
                    },
                },
            )
        self.speech.list_models.assert_not_called()
        self.vision.list_models.assert_not_called()

    def test_unassigned_transcription_role_never_creates_a_client(self):
        self.manager._role_map = {}
        with patch.object(self.manager, "_get_client") as get:
            self.assertIsNone(self.manager.transcribe_client)
            self.assertEqual(self.manager.role_info(), {})
        get.assert_not_called()
