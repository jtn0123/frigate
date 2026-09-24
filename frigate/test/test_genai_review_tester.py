"""Test the standalone review prompt tool without calling external providers."""

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import cv2
import numpy as np

from frigate.genai import PROVIDERS

SCRIPT = Path(__file__).resolve().parents[2] / "testing-scripts/genai_review_tester.py"
SPEC = importlib.util.spec_from_file_location("genai_review_tester", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
tester = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = tester
SPEC.loader.exec_module(tester)


class TestReviewPromptTool(unittest.TestCase):
    """Exercise file handling and interactive workflows with simulated input."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in (
            ("EXAMPLES_DIR", self.root),
            ("SETTINGS_FILE", self.root / ".settings.json"),
        ):
            patcher = patch.object(tester, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        output = patch("sys.stdout", new_callable=io.StringIO)
        self.output = output.start()
        self.addCleanup(output.stop)

    def test_settings_round_trip_ignores_unknown_keys_and_recovers_invalid_files(self):
        self.assertEqual(tester.TesterSettings.load().describe(), "not configured")
        settings = tester.TesterSettings(
            provider="ollama", model="example", runtime_options={"temperature": 0.2}
        )
        settings.save()
        data = json.loads(tester.SETTINGS_FILE.read_text())
        data["obsolete"] = True
        tester.SETTINGS_FILE.write_text(json.dumps(data))
        self.assertEqual(tester.TesterSettings.load(), settings)
        self.assertIn("api_key=none", settings.describe())
        for invalid in ("{broken", "[]"):
            tester.SETTINGS_FILE.write_text(invalid)
            self.assertEqual(tester.TesterSettings.load(), tester.TesterSettings())

    def test_numbered_selection_handles_cancel_invalid_and_bounds(self):
        with patch.object(sys.stdin, "isatty", return_value=False):
            for value, expected in (
                ("", None),
                ("no", None),
                ("0", None),
                ("3", None),
                ("2", 1),
            ):
                with (
                    self.subTest(value=value),
                    patch("builtins.input", return_value=value),
                ):
                    self.assertEqual(
                        tester.select_option("Example", ["a", "b"]), expected
                    )

    def test_keyboard_navigation_restores_terminal(self):
        for keys, expected in (
            ("j\r", 1),
            ("k\n", 1),
            ("\x1b[B\n", 1),
            ("\x1b[A\n", 1),
            ("q", None),
            ("\x1bx", None),
        ):
            with (
                self.subTest(keys=keys),
                patch.object(tester.sys, "stdin") as stdin,
                patch.object(tester.termios, "tcgetattr", return_value=[1]) as get,
                patch.object(tester.termios, "tcsetattr") as restore,
                patch.object(tester.tty, "setcbreak"),
            ):
                stdin.isatty.return_value = True
                stdin.read.side_effect = list(keys)
                self.assertEqual(
                    tester.select_option("Example", ["a", "b"], ["first", "second"]),
                    expected,
                )
                restore.assert_called_once_with(
                    stdin.fileno(), tester.termios.TCSADRAIN, get.return_value
                )

    def test_prompt_keeps_clears_or_changes_value(self):
        for entered, expected in (("", "old"), ("-", ""), (" new ", "new")):
            with patch("builtins.input", return_value=entered):
                self.assertEqual(tester.prompt_text("Value", "old"), expected)

    def test_edit_settings_can_cancel_or_save(self):
        settings = tester.TesterSettings()
        with patch.object(tester, "select_option", return_value=None):
            tester.edit_settings(settings)
        self.assertFalse(tester.SETTINGS_FILE.exists())
        with (
            patch.object(tester, "select_option", return_value=0),
            patch("builtins.input", side_effect=["http://localhost:1234", "", "model"]),
        ):
            tester.edit_settings(settings)
        self.assertEqual(tester.TesterSettings.load(), settings)
        self.assertEqual(settings.model, "model")

    def test_client_rejects_invalid_missing_and_failed_providers(self):
        self.assertIsNone(
            tester.build_client(tester.TesterSettings(provider="unknown"))
        )
        settings = tester.TesterSettings(provider="ollama", model="example")
        with patch.object(
            tester.importlib, "import_module", side_effect=ImportError("missing")
        ):
            self.assertIsNone(tester.build_client(settings))
        client = Mock(provider=None)
        factory = Mock(return_value=client)
        with (
            patch.object(tester.importlib, "import_module"),
            patch.dict(PROVIDERS, {tester.GenAIProviderEnum.ollama: factory}),
        ):
            self.assertIsNone(tester.build_client(settings))
            client.provider = object()
            self.assertIs(tester.build_client(settings), client)
        config = factory.call_args.args[0]
        self.assertEqual(config.model, "example")
        self.assertIsNone(config.base_url)
        self.assertEqual(
            factory.call_args.kwargs, {"timeout": 120, "validate_model": False}
        )

    def test_examples_exclude_hidden_directories_and_plain_files(self):
        for name in ("b", "a", ".hidden"):
            (self.root / name).mkdir()
        (self.root / "file.txt").write_text("not an example")
        self.assertEqual([p.name for p in tester.list_examples()], ["a", "b"])
        with patch.object(tester, "EXAMPLES_DIR", self.root / "missing"):
            self.assertEqual(tester.list_examples(), [])

    def test_frames_sort_numerically_convert_images_and_skip_unreadable(self):
        for name, data in (
            ("10.jpg", b"ten"),
            ("2.JPEG", b"two"),
            ("named.jpg", b"last"),
            ("bad.png", b"invalid"),
            ("ignored.txt", b"ignored"),
        ):
            (self.root / name).write_bytes(data)
        cv2.imwrite(str(self.root / "3.png"), np.zeros((3, 3, 3), dtype=np.uint8))
        frames = tester.load_frames(self.root)
        self.assertEqual(frames[0], b"two")
        self.assertIsNotNone(
            cv2.imdecode(np.frombuffer(frames[1], dtype=np.uint8), cv2.IMREAD_COLOR)
        )
        self.assertEqual(frames[2:], [b"ten", b"last"])
        self.assertIn("Skipping unreadable", self.output.getvalue())

    def test_styles_replace_current_and_legacy_guidance_only(self):
        style, guidance = next(iter(tester.REVIEW_RESPONSE_STYLES.items()))
        for suffix in ("", " (string)"):
            prompt = "Header\n" + "\n".join(
                f"- `{key}`{suffix}: old" for key in guidance
            )
            result = tester.apply_style(prompt, style)
            self.assertTrue(result.startswith("Header\n"))
            for key, value in guidance.items():
                self.assertIn(f"- `{key}`: {value}", result)
        self.assertEqual(tester.apply_style("untouched", "default"), "untouched")
        tester.apply_style("missing guidance", style)
        self.assertIn("Warning", self.output.getvalue())

    def test_response_printing_accepts_json_and_plain_text(self):
        tester.pretty_print_response('{"scene": "Café"}')
        tester.pretty_print_response("plain response")
        self.assertIn('"scene": "Café"', self.output.getvalue())
        self.assertIn("plain response", self.output.getvalue())

    def test_followups_keep_successful_context_and_recover_empty_responses(self):
        client = Mock()
        client._send.side_effect = [None, "first answer", "second answer"]
        with patch("builtins.input", side_effect=["retry", "first", "second", ""]):
            tester.followup_loop(client, "original", [b"frame"])
        self.assertEqual(client._send.call_count, 3)
        self.assertIn("first answer", client._send.call_args.args[0])
        self.assertEqual(client._send.call_args.args[1], [b"frame"])
        with patch("builtins.input", side_effect=EOFError):
            tester.followup_loop(client, "original", [])

    def test_example_stops_for_missing_input_and_provider_failure(self):
        settings = tester.TesterSettings(provider="ollama")
        tester.run_example(settings)
        example = self.root / "example"
        example.mkdir()
        with patch.object(tester, "select_option", side_effect=[None]):
            tester.run_example(settings)
        with patch.object(tester, "select_option", side_effect=[0, None]):
            tester.run_example(settings)
        with patch.object(tester, "select_option", return_value=0):
            tester.run_example(settings)
            (example / "prompt.txt").write_text("prompt")
            tester.run_example(settings)
            (example / "1.jpg").write_bytes(b"frame")
            with patch.object(tester, "build_client", return_value=None):
                tester.run_example(settings)
            with patch.object(
                tester, "build_client", return_value=Mock(_send=Mock(return_value=None))
            ):
                tester.run_example(settings)
        self.assertIn("No response from provider", self.output.getvalue())

    def test_example_passes_frames_schema_and_analysis_to_followup(self):
        example = self.root / "example"
        example.mkdir()
        (example / "prompt.txt").write_text("Include other_concerns")
        (example / "1.jpg").write_bytes(b"frame")
        client = Mock(_send=Mock(return_value='{"scene":"person"}'))
        with (
            patch.object(tester, "select_option", return_value=0),
            patch.object(tester, "build_client", return_value=client),
            patch.object(tester, "followup_loop") as followup,
        ):
            tester.run_example(
                tester.TesterSettings(provider="ollama", model="example")
            )
        self.assertEqual(client._send.call_args.args[1], [b"frame"])
        self.assertIn("other_concerns", str(client._send.call_args.args[2]))
        self.assertIn('Your analysis:\n{"scene":"person"}', followup.call_args.args[1])

    def test_main_routes_settings_and_examples_and_quits(self):
        settings = tester.TesterSettings(provider="ollama")
        with (
            patch.object(tester.os, "chdir"),
            patch.object(tester.TesterSettings, "load", return_value=settings),
            patch.object(tester, "select_option", side_effect=[1, 0, 2]),
            patch.object(tester, "edit_settings") as edit,
            patch.object(tester, "run_example") as run,
        ):
            tester.main()
        edit.assert_called_once_with(settings)
        run.assert_called_once_with(settings)
        with (
            patch.object(tester.os, "chdir"),
            patch.object(
                tester.TesterSettings, "load", return_value=tester.TesterSettings()
            ),
            patch.object(tester, "select_option", side_effect=[0, None]),
            patch.object(tester, "edit_settings") as edit,
            patch.object(tester, "run_example") as run,
        ):
            tester.main()
        edit.assert_called_once()
        run.assert_not_called()
