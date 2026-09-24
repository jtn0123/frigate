"""Tests for the interactive GenAI review prompt tester dev script."""

import importlib.util
import io
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from frigate import genai
from frigate.config.camera.genai import GenAIProviderEnum
from frigate.genai.prompts import REVIEW_RESPONSE_STYLES

_SCRIPT = Path(__file__).resolve().parents[2] / "testing-scripts/genai_review_tester.py"
_SPEC = importlib.util.spec_from_file_location("genai_review_tester_module", _SCRIPT)
tester = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = tester
_SPEC.loader.exec_module(tester)

SAVED_PROMPT = """Header line
- `observations`: base observations
- `scene`: base scene
- `title`: base title
- `shortSummary`: base summary
- `potential_threat_level`: base threat
"""


class _TempExamplesMixin(unittest.TestCase):
    """Point the script's examples folder and settings file at a temp dir."""

    def setUp(self):
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.examples_dir = Path(tmp.name) / "examples"
        self.settings_file = self.examples_dir / ".settings.json"

        for attr, value in (
            ("EXAMPLES_DIR", self.examples_dir),
            ("SETTINGS_FILE", self.settings_file),
        ):
            patcher = patch.object(tester, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def make_example(self, name: str, prompt: str | None = SAVED_PROMPT) -> Path:
        example = self.examples_dir / name
        example.mkdir(parents=True)

        if prompt is not None:
            (example / "prompt.txt").write_text(prompt)

        return example


class TestTesterSettings(_TempExamplesMixin):
    def test_load_without_a_file_returns_defaults(self):
        settings = tester.TesterSettings.load()
        self.assertEqual(settings, tester.TesterSettings())
        self.assertEqual(settings.timeout, 120)

    def test_save_then_load_round_trips_and_ignores_unknown_keys(self):
        tester.TesterSettings(
            provider="ollama", base_url="http://ai:11434", model="qwen"
        ).save()

        data = json.loads(self.settings_file.read_text())
        data["stale_key"] = "ignored"
        self.settings_file.write_text(json.dumps(data))

        loaded = tester.TesterSettings.load()
        self.assertEqual(loaded.provider, "ollama")
        self.assertEqual(loaded.base_url, "http://ai:11434")
        self.assertEqual(loaded.model, "qwen")

    def test_invalid_settings_file_falls_back_to_defaults(self):
        self.examples_dir.mkdir(parents=True)
        self.settings_file.write_text("{not json")

        with patch("sys.stdout", new_callable=io.StringIO) as out:
            settings = tester.TesterSettings.load()

        self.assertEqual(settings, tester.TesterSettings())
        self.assertIn("Ignoring invalid settings file", out.getvalue())

    def test_describe(self):
        self.assertEqual(tester.TesterSettings().describe(), "not configured")
        self.assertEqual(
            tester.TesterSettings(provider="openai").describe(),
            "provider=openai base_url=(default) model=(none) api_key=none",
        )
        self.assertEqual(
            tester.TesterSettings(
                provider="gemini", base_url="u", api_key="secret", model="m"
            ).describe(),
            "provider=gemini base_url=u model=m api_key=set",
        )


class TestSelectOptionFallback(unittest.TestCase):
    """Numbered prompt used when stdin is not a terminal."""

    def _select(self, answer: str) -> int | None:
        stdin = MagicMock()
        stdin.isatty.return_value = False

        with (
            patch.object(tester.sys, "stdin", stdin),
            patch("sys.stdout", new_callable=io.StringIO) as out,
            patch("builtins.input", return_value=answer),
        ):
            result = tester.select_option("Pick:", ["one", "two"])

        self.assertIn("  2. two", out.getvalue())
        return result

    def test_valid_number_selects_that_option(self):
        self.assertEqual(self._select("2"), 1)

    def test_blank_non_numeric_and_out_of_range_cancel(self):
        self.assertIsNone(self._select(""))
        self.assertIsNone(self._select("two"))
        self.assertIsNone(self._select("3"))
        self.assertIsNone(self._select("0"))


class TestSelectOptionArrowKeys(unittest.TestCase):
    """Arrow-key menu rendered when stdin is a terminal."""

    def _select(
        self, keys: list[str], descriptions: list[str] | None = None
    ) -> tuple[int | None, str, MagicMock]:
        stdin = MagicMock()
        stdin.isatty.return_value = True
        stdin.fileno.return_value = 7
        stdin.read.side_effect = keys

        with (
            patch.object(tester.sys, "stdin", stdin),
            patch("sys.stdout", new_callable=io.StringIO) as out,
            patch.object(tester.termios, "tcgetattr", return_value="attrs"),
            patch.object(tester.termios, "tcsetattr") as tcsetattr,
            patch.object(tester.tty, "setcbreak") as setcbreak,
        ):
            result = tester.select_option(
                "Pick:", ["one", "two", "three"], descriptions
            )

        setcbreak.assert_called_once_with(7)
        return result, out.getvalue(), tcsetattr

    def test_down_arrow_then_enter(self):
        result, output, tcsetattr = self._select(["\x1b", "[", "B", "\r"])

        self.assertEqual(result, 1)
        # the menu is redrawn in place after moving
        self.assertIn("\x1b[3A", output)
        self.assertIn("❯ two", output)
        # terminal attributes are always restored
        tcsetattr.assert_called_once_with(7, tester.termios.TCSADRAIN, "attrs")

    def test_up_arrow_wraps_to_the_last_option(self):
        result, _, _ = self._select(["\x1b", "[", "A", "\n"])
        self.assertEqual(result, 2)

    def test_vim_keys_move_the_selection(self):
        result, _, _ = self._select(["j", "j", "k", "\r"])
        self.assertEqual(result, 1)

    def test_other_escape_sequences_are_ignored(self):
        result, _, _ = self._select(["\x1b", "[", "C", "x", "\r"])
        self.assertEqual(result, 0)

    def test_descriptions_are_rendered_next_to_options(self):
        _, output, _ = self._select(["\r"], descriptions=["first", "", "third"])
        self.assertIn("one  (first)", output)
        self.assertIn("three  (third)", output)
        self.assertNotIn("two  (", output)

    def test_bare_escape_q_and_ctrl_c_cancel(self):
        for keys in (["\x1b", "x"], ["q"], ["\x03"]):
            with self.subTest(keys=keys):
                result, _, tcsetattr = self._select(keys)
                self.assertIsNone(result)
                tcsetattr.assert_called_once()


class TestPromptText(unittest.TestCase):
    def test_blank_keeps_dash_clears_and_value_replaces(self):
        with patch("builtins.input", return_value="  ") as prompt:
            self.assertEqual(tester.prompt_text("Model", "qwen"), "qwen")
        prompt.assert_called_once_with("Model [qwen]: ")

        with patch("builtins.input", return_value="-"):
            self.assertEqual(tester.prompt_text("Model", "qwen"), "")

        with patch("builtins.input", return_value=" llava "):
            self.assertEqual(tester.prompt_text("Model", "qwen"), "llava")

    def test_secret_values_are_masked(self):
        with patch("builtins.input", return_value="") as prompt:
            tester.prompt_text("API key", "sk-123", secret=True)
        prompt.assert_called_once_with("API key [***]: ")

        with patch("builtins.input", return_value="") as prompt:
            tester.prompt_text("API key", "", secret=True)
        prompt.assert_called_once_with("API key []: ")


class TestEditSettings(_TempExamplesMixin):
    def test_cancelled_provider_selection_changes_nothing(self):
        settings = tester.TesterSettings(provider="ollama")

        with patch.object(tester, "select_option", return_value=None):
            tester.edit_settings(settings)

        self.assertEqual(settings.provider, "ollama")
        self.assertFalse(self.settings_file.exists())

    def test_selected_values_are_saved(self):
        settings = tester.TesterSettings(model="old")
        providers = [p.value for p in GenAIProviderEnum]

        with (
            patch.object(
                tester, "select_option", return_value=providers.index("gemini")
            ),
            patch("builtins.input", side_effect=["http://ai", "key", ""]),
            patch("sys.stdout", new_callable=io.StringIO) as out,
        ):
            tester.edit_settings(settings)

        self.assertEqual(settings.provider, "gemini")
        self.assertEqual(settings.base_url, "http://ai")
        self.assertEqual(settings.api_key, "key")
        self.assertEqual(settings.model, "old")
        self.assertEqual(json.loads(self.settings_file.read_text())["api_key"], "key")
        self.assertIn("Saved settings: provider=gemini", out.getvalue())


class TestBuildClient(unittest.TestCase):
    def test_every_provider_maps_to_a_plugin_module(self):
        plugins = Path(tester.REPO_ROOT) / "frigate/genai/plugins"

        self.assertEqual(set(tester.PROVIDER_MODULES), set(GenAIProviderEnum))
        for module in tester.PROVIDER_MODULES.values():
            self.assertTrue((plugins / f"{module}.py").is_file(), module)

    def test_unknown_provider_returns_none(self):
        with patch("sys.stdout", new_callable=io.StringIO) as out:
            client = tester.build_client(tester.TesterSettings(provider="nope"))

        self.assertIsNone(client)
        self.assertIn("No valid provider configured", out.getvalue())

    def test_plugin_import_failure_returns_none(self):
        with (
            patch.object(tester, "importlib") as importlib_mock,
            patch("sys.stdout", new_callable=io.StringIO) as out,
        ):
            importlib_mock.import_module.side_effect = ImportError("no sdk")
            client = tester.build_client(tester.TesterSettings(provider="gemini"))

        self.assertIsNone(client)
        self.assertIn(
            "Failed to import provider plugin 'gemini': no sdk", out.getvalue()
        )

    def _build(self, provider_instance: object) -> tuple[object, MagicMock]:
        provider_cls = MagicMock(return_value=provider_instance)
        settings = tester.TesterSettings(
            provider="azure_openai",
            base_url="",
            api_key="k",
            model="gpt",
            timeout=30,
            runtime_options={"temperature": 0},
        )

        with (
            patch.object(tester, "importlib") as importlib_mock,
            patch.dict(genai.PROVIDERS, {GenAIProviderEnum.azure_openai: provider_cls}),
            patch("sys.stdout", new_callable=io.StringIO),
        ):
            client = tester.build_client(settings)

        importlib_mock.import_module.assert_called_once_with(
            "frigate.genai.plugins.azure-openai"
        )
        return client, provider_cls

    def test_builds_the_provider_client_from_settings(self):
        instance = SimpleNamespace(provider=object())
        client, provider_cls = self._build(instance)

        self.assertIs(client, instance)
        config = provider_cls.call_args.args[0]
        self.assertEqual(config.provider, GenAIProviderEnum.azure_openai)
        self.assertIsNone(config.base_url)
        self.assertEqual(config.api_key, "k")
        self.assertEqual(config.model, "gpt")
        self.assertEqual(config.runtime_options, {"temperature": 0})
        self.assertEqual(
            provider_cls.call_args.kwargs, {"timeout": 30, "validate_model": False}
        )

    def test_uninitialized_provider_returns_none(self):
        client, _ = self._build(SimpleNamespace(provider=None))
        self.assertIsNone(client)


class TestExamplesAndFrames(_TempExamplesMixin):
    def test_list_examples_without_a_folder(self):
        self.assertEqual(tester.list_examples(), [])

    def test_list_examples_returns_sorted_visible_folders(self):
        self.make_example("b")
        self.make_example("a")
        self.make_example(".hidden")
        (self.examples_dir / "notes.txt").write_text("x")

        self.assertEqual([e.name for e in tester.list_examples()], ["a", "b"])

    def test_load_frames_orders_numerically_and_reencodes_to_jpeg(self):
        example = self.make_example("ex")
        (example / "10.jpg").write_bytes(b"jpg-10")
        (example / "2.JPEG").write_bytes(b"jpg-2")
        (example / "cover.jpg").write_bytes(b"jpg-cover")
        (example / "3.png").write_bytes(b"not an image")
        (example / "notes.txt").write_text("ignored")
        cv2.imwrite(str(example / "1.png"), np.zeros((4, 4, 3), dtype=np.uint8))

        with patch("sys.stdout", new_callable=io.StringIO) as out:
            frames = tester.load_frames(example)

        self.assertEqual(len(frames), 4)
        # the png is decoded and re-encoded as a jpeg
        self.assertTrue(frames[0].startswith(b"\xff\xd8"))
        self.assertEqual(frames[1:], [b"jpg-2", b"jpg-10", b"jpg-cover"])
        self.assertIn("Skipping unreadable image 3.png", out.getvalue())

    def test_load_frames_drops_images_that_fail_to_encode(self):
        example = self.make_example("ex")
        cv2.imwrite(str(example / "0.png"), np.zeros((4, 4, 3), dtype=np.uint8))

        with patch.object(cv2, "imencode", return_value=(False, None)):
            self.assertEqual(tester.load_frames(example), [])


class TestApplyStyle(unittest.TestCase):
    def test_default_style_leaves_prompt_unchanged(self):
        self.assertEqual(tester.apply_style(SAVED_PROMPT, "default"), SAVED_PROMPT)

    def test_preset_replaces_user_facing_guidance_only(self):
        styled = tester.apply_style(SAVED_PROMPT, "concise")
        concise = REVIEW_RESPONSE_STYLES["concise"]

        self.assertIn(f"- `scene`: {concise['scene']}", styled)
        self.assertIn(f"- `title`: {concise['title']}", styled)
        self.assertIn(f"- `shortSummary`: {concise['shortSummary']}", styled)
        self.assertIn("- `observations`: base observations", styled)
        self.assertIn("- `potential_threat_level`: base threat", styled)
        self.assertNotIn("base scene", styled)

    def test_handles_the_legacy_typed_guidance_format(self):
        legacy = "- `scene` (string): old\n- `title` (string): old\n"
        legacy += "- `shortSummary` (string): old\n"
        styled = tester.apply_style(legacy, "natural")

        self.assertNotIn("(string)", styled)
        self.assertIn(
            f"- `scene`: {REVIEW_RESPONSE_STYLES['natural']['scene']}", styled
        )

    def test_warns_when_a_field_is_missing(self):
        with patch("sys.stdout", new_callable=io.StringIO) as out:
            styled = tester.apply_style("- `scene`: old\n", "detailed")

        self.assertIn("no `title` guidance found", out.getvalue())
        self.assertIn(REVIEW_RESPONSE_STYLES["detailed"]["scene"], styled)

    def test_guidance_containing_regex_escapes_is_inserted_literally(self):
        style = {"scene": r"use \1 and \n literally"}

        with patch.dict(tester.REVIEW_RESPONSE_STYLES, {"raw": style}):
            styled = tester.apply_style("- `scene`: old\n", "raw")

        self.assertEqual(styled, "- `scene`: use \\1 and \\n literally\n")


class TestResponseOutput(unittest.TestCase):
    def test_json_is_pretty_printed(self):
        with patch("sys.stdout", new_callable=io.StringIO) as out:
            tester.pretty_print_response('{"title": "Café"}')
        self.assertEqual(out.getvalue(), '{\n  "title": "Café"\n}\n')

    def test_non_json_is_printed_as_is(self):
        with patch("sys.stdout", new_callable=io.StringIO) as out:
            tester.pretty_print_response("plain text")
        self.assertEqual(out.getvalue(), "plain text\n")


class TestFollowupLoop(unittest.TestCase):
    def test_questions_carry_the_growing_transcript(self):
        client = MagicMock()
        client._send.side_effect = [None, "It was a cat."]

        with (
            patch("builtins.input", side_effect=["what?", "which animal?", ""]),
            patch("sys.stdout", new_callable=io.StringIO) as out,
        ):
            tester.followup_loop(client, "BASE", [b"f"])

        self.assertEqual(client._send.call_count, 2)
        # a failed answer does not enter the transcript
        second_prompt = client._send.call_args_list[1].args[0]
        self.assertTrue(second_prompt.startswith("BASE\n\n---\n"))
        self.assertNotIn("what?", second_prompt)
        self.assertTrue(second_prompt.endswith("Question: which animal?"))
        self.assertEqual(client._send.call_args_list[1].args[1], [b"f"])
        self.assertIn("No response from provider", out.getvalue())
        self.assertIn("It was a cat.", out.getvalue())

    def test_answers_are_appended_for_the_next_question(self):
        client = MagicMock()
        client._send.side_effect = ["first answer", "second answer"]

        with (
            patch("builtins.input", side_effect=["q1", "q2", EOFError]),
            patch("sys.stdout", new_callable=io.StringIO),
        ):
            tester.followup_loop(client, "BASE", [])

        second_prompt = client._send.call_args_list[1].args[0]
        self.assertIn("Question: q1\n\nYour answer:\nfirst answer", second_prompt)


class TestRunExample(_TempExamplesMixin):
    def setUp(self):
        super().setUp()
        self.settings = tester.TesterSettings(provider="ollama", model="qwen")
        self.out = io.StringIO()
        patcher = patch("sys.stdout", self.out)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, selections, client=None, frames=None):
        with (
            patch.object(tester, "select_option", side_effect=selections),
            patch.object(tester, "build_client", return_value=client) as build,
            patch.object(
                tester,
                "load_frames",
                return_value=[b"f1", b"f2"] if frames is None else frames,
            ),
            patch.object(tester, "followup_loop") as followup,
        ):
            tester.run_example(self.settings)

        return build, followup

    def test_no_examples(self):
        self._run([])
        self.assertIn("No examples found", self.out.getvalue())

    def test_cancelled_example_or_style_selection(self):
        self.make_example("ex")

        for selections in ([None], [0, None]):
            with self.subTest(selections=selections):
                build, _ = self._run(selections)
                build.assert_not_called()

    def test_example_without_prompt(self):
        self.make_example("ex", prompt=None)
        build, _ = self._run([0, 0])
        build.assert_not_called()
        self.assertIn("ex has no prompt.txt", self.out.getvalue())

    def test_example_without_frames(self):
        self.make_example("ex")
        build, _ = self._run([0, 0], frames=[])
        build.assert_not_called()
        self.assertIn("ex contains no frame images", self.out.getvalue())

    def test_client_failure_stops_the_run(self):
        self.make_example("ex")
        _, followup = self._run([0, 0], client=None)
        followup.assert_not_called()

    def test_empty_response_skips_followups(self):
        self.make_example("ex")
        client = MagicMock()
        client._send.return_value = None

        _, followup = self._run([0, 0], client=client)

        followup.assert_not_called()
        self.assertIn("No response from provider", self.out.getvalue())

    def test_sends_styled_prompt_and_starts_followups(self):
        self.make_example("ex")
        client = MagicMock()
        client._send.return_value = '{"title": "Delivery"}'
        styles = ["default"] + list(REVIEW_RESPONSE_STYLES)

        _, followup = self._run([0, styles.index("concise")], client=client)

        prompt, frames, response_format = client._send.call_args.args
        self.assertIn(REVIEW_RESPONSE_STYLES["concise"]["scene"], prompt)
        self.assertEqual(frames, [b"f1", b"f2"])
        schema = response_format["json_schema"]["schema"]
        # the saved prompt did not ask for other concerns
        self.assertNotIn("other_concerns", schema["properties"])
        self.assertIn("style=concise", self.out.getvalue())
        self.assertIn('"title": "Delivery"', self.out.getvalue())

        followup_client, transcript, followup_frames = followup.call_args.args
        self.assertIs(followup_client, client)
        self.assertTrue(
            transcript.endswith('\n\nYour analysis:\n{"title": "Delivery"}')
        )
        self.assertEqual(followup_frames, [b"f1", b"f2"])

    def test_keeps_other_concerns_when_the_prompt_asked_for_them(self):
        self.make_example("ex", prompt=SAVED_PROMPT + "- `other_concerns`: list\n")
        client = MagicMock()
        client._send.return_value = "{}"

        self._run([0, 0], client=client)

        schema = client._send.call_args.args[2]["json_schema"]["schema"]
        self.assertIn("other_concerns", schema["properties"])


class TestMain(_TempExamplesMixin):
    def _main(self, choices, edit_effect=None):
        with (
            patch.object(tester.os, "chdir") as chdir,
            patch.object(tester.logging, "basicConfig"),
            patch.object(tester, "select_option", side_effect=choices),
            patch.object(tester, "edit_settings", side_effect=edit_effect) as edit,
            patch.object(tester, "run_example") as run,
            patch("sys.stdout", new_callable=io.StringIO) as out,
        ):
            tester.main()

        chdir.assert_called_once_with(tester.REPO_ROOT)
        self.assertTrue(self.examples_dir.is_dir())
        return edit, run, out.getvalue()

    def test_quit_and_cancel_exit(self):
        for choice in (2, None):
            with self.subTest(choice=choice):
                edit, run, _ = self._main([choice])
                edit.assert_not_called()
                run.assert_not_called()

    def test_run_without_provider_asks_for_settings_first(self):
        edit, run, output = self._main([0, 2])

        self.assertIn("Configure provider settings first.", output)
        edit.assert_called_once()
        run.assert_not_called()

    def test_run_after_configuring_a_provider(self):
        def configure(settings):
            settings.provider = "ollama"

        edit, run, _ = self._main([0, 1, 0, 2], edit_effect=configure)

        self.assertEqual(edit.call_count, 2)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args[0].provider, "ollama")


class TestScriptEntryPoint(unittest.TestCase):
    def test_ctrl_c_exits_cleanly(self):
        stdin = MagicMock()
        stdin.isatty.return_value = False

        with (
            patch("os.chdir"),
            patch("logging.basicConfig"),
            patch.object(sys, "stdin", stdin),
            patch("builtins.input", side_effect=KeyboardInterrupt),
            patch("sys.stdout", new_callable=io.StringIO) as out,
            patch.object(sys, "path", list(sys.path)),
        ):
            runpy.run_path(str(_SCRIPT), run_name="__main__")

        self.assertIn("Frigate GenAI review prompt tester", out.getvalue())
        self.assertTrue(out.getvalue().endswith("\n"))


if __name__ == "__main__":
    unittest.main()
