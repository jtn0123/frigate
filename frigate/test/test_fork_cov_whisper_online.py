"""Coverage for the whisper streaming backends and online processors (fork D73).

Every ASR backend library (whisper, faster_whisper, mlx, openai, torch,
tokenizers) is replaced with a fake module, so no model is ever loaded.
"""

import argparse
import io
import logging
import runpy
import sys
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.data_processing.real_time import whisper_online as wo
from frigate.data_processing.real_time.whisper_online import (
    ASRBase,
    FasterWhisperASR,
    HypothesisBuffer,
    MLXWhisper,
    OnlineASRProcessor,
    OpenaiApiASR,
    VACOnlineASRProcessor,
    WhisperTimestampedASR,
)

SR = 16000


def _audio(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


class FakeASR:
    """Scripted ASR returning ``(words, segment_ends)`` per transcribe call."""

    sep = " "

    def __init__(self, results: list[tuple[list, list]]) -> None:
        self.results = list(results)
        self.prompts: list[str] = []

    def transcribe(self, audio: np.ndarray, init_prompt: str = "") -> tuple:
        self.prompts.append(init_prompt)
        if len(self.results) > 1:
            return self.results.pop(0)
        return self.results[0]

    def ts_words(self, res: tuple) -> list:
        return list(res[0])

    def segments_end_ts(self, res: tuple) -> list:
        return list(res[1])


class SplitTokenizer:
    """Sentence splitter that splits after a period."""

    def split(self, text: str) -> list[str]:
        parts = [p.strip() for p in text.split(".") if p.strip()]
        return [p + "." for p in parts]


class TestLoadAudio(unittest.TestCase):
    def setUp(self) -> None:
        wo.load_audio.cache_clear()
        self.addCleanup(wo.load_audio.cache_clear)

    def test_load_audio_is_cached_and_chunked(self):
        samples = np.arange(SR * 2, dtype=np.float32)
        librosa = SimpleNamespace(load=MagicMock(return_value=(samples, SR)))
        load = librosa.load
        with patch.object(wo, "librosa", librosa):
            chunk = wo.load_audio_chunk("clip.wav", 0.5, 1.0)
            again = wo.load_audio("clip.wav")
        load.assert_called_once_with("clip.wav", sr=16000, dtype=np.float32)
        self.assertEqual(len(chunk), SR // 2)
        self.assertEqual(chunk[0], SR // 2)
        self.assertIs(again, samples)


class TestASRBase(unittest.TestCase):
    def test_base_methods_are_abstract(self):
        with self.assertRaises(NotImplementedError):
            ASRBase("en")
        base = object.__new__(ASRBase)
        with self.assertRaises(NotImplementedError):
            base.transcribe(_audio(0.1))
        with self.assertRaises(NotImplementedError):
            base.use_vad()

    def test_auto_language_is_none(self):
        class Dummy(ASRBase):
            def load_model(self, *args: Any, **kwargs: Any) -> str:
                return "model"

        self.assertIsNone(Dummy("auto").original_language)
        dummy = Dummy("de")
        self.assertEqual(dummy.original_language, "de")
        self.assertEqual(dummy.model, "model")
        self.assertEqual(dummy.transcribe_kargs, {})


class TestWhisperTimestampedASR(unittest.TestCase):
    def setUp(self) -> None:
        self.whisper = MagicMock()
        self.timestamped = MagicMock()
        with (
            patch.dict(
                "sys.modules",
                {"whisper": self.whisper, "whisper_timestamped": self.timestamped},
            ),
            self.assertLogs(wo.logger, level="DEBUG") as logs,
        ):
            self.asr = WhisperTimestampedASR("en", modelsize="tiny", model_dir="/m")
        self.assertIn("ignoring model_dir", logs.output[0])

    def test_transcribe_passes_options(self):
        self.asr.use_vad()
        self.asr.set_translate_task()
        audio = _audio(0.1)
        result = self.asr.transcribe(audio, init_prompt="hi")
        self.assertIs(result, self.timestamped.transcribe_timestamped.return_value)
        kwargs = self.timestamped.transcribe_timestamped.call_args.kwargs
        self.assertEqual(kwargs["language"], "en")
        self.assertEqual(kwargs["initial_prompt"], "hi")
        self.assertTrue(kwargs["vad"])
        self.assertEqual(kwargs["task"], "translate")

    def test_words_and_segment_ends(self):
        res = {
            "segments": [
                {"end": 1.0, "words": [{"start": 0, "end": 0.5, "text": "a"}]},
                {"end": 2.0, "words": [{"start": 1, "end": 2.0, "text": "b"}]},
            ]
        }
        self.assertEqual(self.asr.ts_words(res), [(0, 0.5, "a"), (1, 2.0, "b")])
        self.assertEqual(self.asr.segments_end_ts(res), [1.0, 2.0])


class TestFasterWhisperASR(unittest.TestCase):
    def setUp(self) -> None:
        self.faster = MagicMock()
        patcher = patch.dict("sys.modules", {"faster_whisper": self.faster})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.asr = FasterWhisperASR("auto", device="cpu")

    def test_transcribe_uses_batched_pipeline(self):
        segments = [SimpleNamespace(end=1.0), SimpleNamespace(end=2.0)]
        pipeline = self.faster.BatchedInferencePipeline.return_value
        pipeline.transcribe.return_value = (iter(segments), "info")
        self.asr.use_vad()
        self.asr.set_translate_task()
        result = self.asr.transcribe(_audio(0.1), init_prompt="p")
        self.assertEqual(result, segments)
        self.faster.BatchedInferencePipeline.assert_called_once_with(
            model=self.asr.model
        )
        kwargs = pipeline.transcribe.call_args.kwargs
        self.assertIsNone(kwargs["language"])
        self.assertEqual(kwargs["beam_size"], 5)
        self.assertTrue(kwargs["vad_filter"])
        self.assertEqual(kwargs["task"], "translate")
        self.assertEqual(self.asr.segments_end_ts(result), [1.0, 2.0])

    def test_ts_words_skips_no_speech_segments(self):
        word = SimpleNamespace(word=" hi", start=0.0, end=0.4)
        noise = SimpleNamespace(word=" uh", start=1.0, end=1.2)
        segments = [
            SimpleNamespace(words=[word], no_speech_prob=0.1),
            SimpleNamespace(words=[noise], no_speech_prob=0.95),
        ]
        self.assertEqual(self.asr.ts_words(segments), [(0.0, 0.4, " hi")])


class TestMLXWhisper(unittest.TestCase):
    def setUp(self) -> None:
        self.mlx = MagicMock()
        self.transcribe_mod = MagicMock()
        patcher = patch.dict(
            "sys.modules",
            {
                "mlx": self.mlx,
                "mlx.core": self.mlx.core,
                "mlx_whisper": MagicMock(),
                "mlx_whisper.transcribe": self.transcribe_mod,
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_modelsize_is_translated(self):
        asr = MLXWhisper("en", modelsize="large-v3-turbo")
        self.assertEqual(asr.model_size_or_path, "mlx-community/whisper-large-v3-turbo")
        self.transcribe_mod.ModelHolder.get_model.assert_called_once_with(
            "mlx-community/whisper-large-v3-turbo", self.mlx.core.float16
        )
        self.assertEqual(
            asr.translate_model_name("tiny"), "mlx-community/whisper-tiny-mlx"
        )
        with self.assertRaises(ValueError):
            asr.translate_model_name("huge")

    def test_without_model_dir_or_size_fails(self):
        # Upstream bug: with neither model_dir nor modelsize the local
        # model_size_or_path is never assigned, so loading raises
        # UnboundLocalError instead of a clear configuration error.
        with self.assertRaises(UnboundLocalError):
            MLXWhisper("en")

    def test_transcribe_and_words(self):
        asr = MLXWhisper("en", model_dir="/models/mlx")
        segments = [
            {
                "end": 1.0,
                "no_speech_prob": 0.1,
                "words": [{"start": 0.0, "end": 0.5, "word": "yes"}],
            },
            {
                "end": 2.0,
                "no_speech_prob": 0.95,
                "words": [{"start": 1.0, "end": 1.5, "word": "noise"}],
            },
            {"end": 3.0},
        ]
        asr.model = MagicMock(return_value={"segments": segments})
        asr.use_vad()
        asr.set_translate_task()
        self.assertEqual(asr.transcribe(_audio(0.1), init_prompt="x"), segments)
        kwargs = asr.model.call_args.kwargs
        self.assertEqual(kwargs["path_or_hf_repo"], "/models/mlx")
        self.assertTrue(kwargs["vad_filter"])
        self.assertEqual(kwargs["task"], "translate")
        self.assertEqual(asr.ts_words(segments), [(0.0, 0.5, "yes")])
        self.assertEqual(asr.segments_end_ts(segments), [1.0, 2.0, 3.0])
        asr.model = MagicMock(return_value={})
        self.assertEqual(asr.transcribe(_audio(0.1)), [])


class TestOpenaiApiASR(unittest.TestCase):
    def setUp(self) -> None:
        self.openai = MagicMock()
        patcher = patch.dict("sys.modules", {"openai": self.openai})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.asr = OpenaiApiASR(lan="de")
        self.client = self.openai.OpenAI.return_value

    def test_init_defaults(self):
        self.assertEqual(self.asr.modelname, "whisper-1")
        self.assertEqual(self.asr.original_language, "de")
        self.assertEqual(self.asr.task, "transcribe")
        self.assertFalse(self.asr.use_vad_opt)
        self.assertIsNone(OpenaiApiASR(lan="auto").original_language)

    def test_transcribe_sends_wav_with_language_and_prompt(self):
        result = self.asr.transcribe(_audio(1.5), prompt="earlier")
        create = self.client.audio.transcriptions.create
        self.assertIs(result, create.return_value)
        params = create.call_args.kwargs
        self.assertEqual(params["language"], "de")
        self.assertEqual(params["prompt"], "earlier")
        self.assertEqual(params["file"].name, "temp.wav")
        self.assertEqual(params["file"].read(4), b"RIFF")
        self.assertEqual(self.asr.transcribed_seconds, 2)

    def test_translate_omits_language(self):
        self.asr.set_translate_task()
        self.asr.transcribe(_audio(0.5))
        params = self.client.audio.translations.create.call_args.kwargs
        self.assertNotIn("language", params)
        self.assertNotIn("prompt", params)
        self.client.audio.transcriptions.create.assert_not_called()

    def test_ts_words_with_vad_drops_no_speech_words(self):
        words = [
            SimpleNamespace(start=0.0, end=0.5, word="hello"),
            SimpleNamespace(start=1.2, end=1.4, word="hmm"),
        ]
        res = SimpleNamespace(
            words=words,
            segments=[
                {"start": 0.0, "end": 1.0, "no_speech_prob": 0.1},
                {"start": 1.0, "end": 2.0, "no_speech_prob": 0.9},
            ],
        )
        self.assertEqual(len(self.asr.ts_words(res)), 2)
        self.asr.use_vad()
        self.assertEqual(self.asr.ts_words(res), [(0.0, 0.5, "hello")])
        self.assertEqual(self.asr.segments_end_ts(res), [0.5, 1.4])


class TestHypothesisBuffer(unittest.TestCase):
    def test_flush_commits_common_prefix(self):
        buf = HypothesisBuffer()
        buf.insert([(0, 1, "a"), (1, 2, "b")], offset=0)
        self.assertEqual(buf.flush(), [])
        buf.insert([(0, 1, "a"), (1, 2, "c"), (2, 3, "d")], offset=0)
        self.assertEqual(buf.flush(), [(0, 1, "a")])
        self.assertEqual(buf.last_commited_word, "a")
        self.assertEqual(buf.last_commited_time, 1)
        self.assertEqual(buf.complete(), [(1, 2, "c"), (2, 3, "d")])
        self.assertEqual(buf.commited_in_buffer, [(0, 1, "a")])

    def test_insert_applies_offset_and_drops_old_words(self):
        buf = HypothesisBuffer()
        buf.last_commited_time = 5
        buf.insert([(0, 1, "old"), (1, 2, "new")], offset=4)
        self.assertEqual(buf.new, [(5, 6, "new")])

    def test_insert_removes_repeated_ngram(self):
        buf = HypothesisBuffer()
        buf.commited_in_buffer = [(0, 1, "hello"), (1, 2, "big"), (2, 3, "world")]
        buf.last_commited_time = 3
        with self.assertLogs(wo.logger, level="DEBUG") as logs:
            buf.insert([(2.95, 3, "big"), (3, 3.5, "world"), (3.5, 4, "x")], 0)
        self.assertEqual(buf.new, [(3.5, 4, "x")])
        self.assertIn("removing last 2 words", logs.output[0])

    def test_pop_commited(self):
        buf = HypothesisBuffer()
        buf.commited_in_buffer = [(0, 1, "a"), (1, 2, "b"), (2, 3, "c")]
        buf.pop_commited(2)
        self.assertEqual(buf.commited_in_buffer, [(2, 3, "c")])


class TestOnlineASRProcessor(unittest.TestCase):
    def test_init_with_offset(self):
        proc = OnlineASRProcessor(FakeASR([([], [])]))
        proc.init(offset=4.0)
        self.assertEqual(proc.buffer_time_offset, 4.0)
        self.assertEqual(proc.transcript_buffer.last_commited_time, 4.0)
        self.assertEqual(proc.buffer_trimming_way, "segment")
        self.assertEqual(proc.buffer_trimming_sec, 15)

    def test_prompt_splits_scrolled_and_buffered_text(self):
        proc = OnlineASRProcessor(FakeASR([([], [])]))
        proc.commited = [(0, 1, "a"), (1, 2, "b"), (2, 3, "c"), (3, 4, "d")]
        proc.buffer_time_offset = 2.5
        self.assertEqual(proc.prompt(), ("a b", "c d"))

    def test_prompt_is_capped_at_200_characters(self):
        proc = OnlineASRProcessor(FakeASR([([], [])]))
        word = "w" * 49
        proc.commited = [(i, i + 1, f"{word}{i}") for i in range(10)]
        proc.buffer_time_offset = 100
        prompt, context = proc.prompt()
        self.assertEqual(prompt.split(" ")[0], f"{word}5")
        self.assertEqual(len(prompt.split(" ")), 4)
        self.assertEqual(context, f"{word}9")

    def test_process_iter_commits_and_trims_segment(self):
        words = [(0.0, 0.5, "hello"), (0.5, 1.0, "world"), (1.2, 1.8, "again")]
        asr = FakeASR([(words, [1.0, 1.8])])
        proc = OnlineASRProcessor(asr, buffer_trimming=("segment", 1))
        proc.insert_audio_chunk(_audio(2.0))
        self.assertEqual(proc.process_iter(), (None, None, ""))
        self.assertEqual(proc.buffer_time_offset, 0)
        result = proc.process_iter()
        self.assertEqual(result, (0.0, 1.8, "hello world again"))
        # the second-to-last segment end (1.0) is inside the committed area
        self.assertEqual(proc.buffer_time_offset, 1.0)
        self.assertEqual(len(proc.audio_buffer), SR)
        self.assertEqual(proc.transcript_buffer.commited_in_buffer, [words[2]])
        self.assertEqual(proc.finish(), (None, None, ""))
        self.assertEqual(proc.buffer_time_offset, 2.0)

    def test_process_iter_sentence_trimming(self):
        words = [
            (0.0, 0.5, "Hi."),
            (0.6, 1.0, "How"),
            (1.0, 1.4, "are"),
            (1.4, 1.9, "you."),
            (2.0, 2.5, "Fine."),
        ]
        asr = FakeASR([(words, [2.5])])
        proc = OnlineASRProcessor(
            asr, tokenizer=SplitTokenizer(), buffer_trimming=("sentence", 1)
        )
        proc.insert_audio_chunk(_audio(3.0))
        proc.process_iter()
        result = proc.process_iter()
        self.assertEqual(result, (0.0, 2.5, "Hi. How are you. Fine."))
        # three sentences, keep the last two and cut at the end of "you."
        self.assertEqual(proc.buffer_time_offset, 1.9)
        self.assertEqual(asr.prompts, ["", ""])

    def test_sentence_mode_trims_long_buffer_by_segment(self):
        words = [(0.0, 10.0, "one"), (10.0, 20.0, "two")]
        asr = FakeASR([(words, [10.0, 31.0])])
        proc = OnlineASRProcessor(
            asr, tokenizer=SplitTokenizer(), buffer_trimming=("sentence", 100)
        )
        proc.insert_audio_chunk(_audio(31.0))
        proc.process_iter()
        proc.process_iter()
        self.assertEqual(proc.buffer_time_offset, 10.0)

    def test_chunk_completed_sentence_edge_cases(self):
        proc = OnlineASRProcessor(FakeASR([([], [])]), tokenizer=SplitTokenizer())
        proc.chunk_completed_sentence()
        self.assertEqual(proc.buffer_time_offset, 0)
        proc.commited = [(0.0, 1.0, "Only.")]
        proc.chunk_completed_sentence()
        self.assertEqual(proc.buffer_time_offset, 0)

    def test_chunk_completed_segment_branches(self):
        proc = OnlineASRProcessor(FakeASR([([], [])]))
        proc.insert_audio_chunk(_audio(4.0))
        proc.chunk_completed_segment(([], [1.0, 2.0]))
        self.assertEqual(proc.buffer_time_offset, 0)

        proc.commited = [(0.0, 1.0, "a")]
        with self.assertLogs(wo.logger, level="DEBUG") as logs:
            proc.chunk_completed_segment(([], [1.0]))
            proc.chunk_completed_segment(([], [1.5, 2.0]))
        self.assertIn("not enough segments", logs.output[0])
        self.assertIn("not within commited area", logs.output[1])
        self.assertEqual(proc.buffer_time_offset, 0)

        proc.chunk_completed_segment(([], [0.5, 1.5, 2.5]))
        self.assertEqual(proc.buffer_time_offset, 0.5)
        self.assertEqual(len(proc.audio_buffer), int(3.5 * SR))

    def test_to_flush_with_custom_separator_and_offset(self):
        proc = OnlineASRProcessor(FakeASR([([], [])]))
        self.assertEqual(
            proc.to_flush([(1, 2, "a"), (2, 3, "b")], sep="-", offset=10),
            (11, 13, "a-b"),
        )


class FakeVAD:
    """Scripted silero VAD iterator."""

    def __init__(self, model: Any) -> None:
        self.model = model
        self.results: list[Any] = []
        self.resets = 0

    def __call__(self, audio: np.ndarray) -> Any:
        return self.results.pop(0) if self.results else None

    def reset_states(self) -> None:
        self.resets += 1


class TestVACOnlineASRProcessor(unittest.TestCase):
    def _make(self, words: list | None = None) -> VACOnlineASRProcessor:
        torch = MagicMock()
        torch.hub.load.return_value = ("vad-model", "utils")
        silero = SimpleNamespace(FixedVADIterator=FakeVAD)
        self.log = io.StringIO()
        asr = FakeASR([(words or [], [])])
        with patch.dict("sys.modules", {"torch": torch, "silero_vad_iterator": silero}):
            proc = VACOnlineASRProcessor(0.5, asr, logfile=self.log)
        torch.hub.load.assert_called_once_with(
            repo_or_dir="snakers4/silero-vad", model="silero_vad"
        )
        return proc

    def test_init_resets_everything(self):
        proc = self._make()
        self.assertEqual(proc.vac.model, "vad-model")
        self.assertEqual(proc.vac.resets, 1)
        self.assertIsNone(proc.status)
        self.assertIs(proc.logfile, self.log)

    def test_silence_keeps_only_last_second(self):
        proc = self._make()
        proc.insert_audio_chunk(_audio(1.5))
        self.assertEqual(len(proc.audio_buffer), SR)
        self.assertEqual(proc.buffer_offset, SR // 2)
        self.assertEqual(proc.process_iter(), (None, None, ""))
        self.assertIn("no online update, only VAD None", self.log.getvalue())

    def test_voice_start_then_continue_then_end(self):
        proc = self._make()
        proc.vac.results = [{"start": 8000}, None, {"end": 20000}]
        proc.insert_audio_chunk(_audio(1.0))
        self.assertEqual(proc.status, "voice")
        self.assertEqual(proc.online.buffer_time_offset, 0.5)
        self.assertEqual(len(proc.online.audio_buffer), 8000)
        self.assertEqual(proc.buffer_offset, SR)

        proc.insert_audio_chunk(_audio(0.25))
        self.assertEqual(len(proc.online.audio_buffer), 12000)
        self.assertEqual(proc.buffer_offset, 20000)

        proc.insert_audio_chunk(_audio(0.25))
        self.assertEqual(proc.status, "nonvoice")
        self.assertTrue(proc.is_currently_final)
        # end frame equals the buffer offset, so nothing more is sent
        self.assertEqual(len(proc.online.audio_buffer), 12000)
        self.assertEqual(proc.process_iter(), (None, None, ""))
        self.assertFalse(proc.is_currently_final)
        self.assertEqual(proc.current_online_chunk_buffer_size, 0)

    def test_start_and_end_in_one_chunk(self):
        proc = self._make()
        proc.vac.results = [{"start": 4000, "end": 12000}]
        proc.insert_audio_chunk(_audio(1.0))
        self.assertEqual(proc.status, "nonvoice")
        self.assertEqual(proc.online.buffer_time_offset, 0.25)
        self.assertEqual(len(proc.online.audio_buffer), 8000)
        self.assertTrue(proc.is_currently_final)

    def test_process_iter_runs_online_when_chunk_is_large(self):
        proc = self._make(words=[(0.0, 0.5, "hey")])
        proc.vac.results = [{"start": 0}]
        proc.insert_audio_chunk(_audio(1.0))
        self.assertEqual(proc.process_iter(), (None, None, ""))
        self.assertEqual(proc.current_online_chunk_buffer_size, 0)
        self.assertEqual(proc.online.transcript_buffer.buffer, [(0.0, 0.5, "hey")])


class TestCreateTokenizer(unittest.TestCase):
    def test_rejects_unknown_language(self):
        with self.assertRaises(AssertionError):
            wo.create_tokenizer("xx")

    def test_ukrainian(self):
        uk = MagicMock()
        uk.tokenize_sents.return_value = ["a", "b"]
        with patch.dict("sys.modules", {"tokenize_uk": uk}):
            tok = wo.create_tokenizer("uk")
        self.assertEqual(tok.split("a b"), ["a", "b"])

    def test_moses_languages(self):
        moses = MagicMock()
        with patch.dict("sys.modules", {"mosestokenizer": moses}):
            tok = wo.create_tokenizer("en")
        self.assertIs(tok, moses.MosesTokenizer.return_value)
        moses.MosesTokenizer.assert_called_once_with("en")

    def test_wtpsplit_with_and_without_language(self):
        wtpsplit = MagicMock()
        wtp = wtpsplit.WtP.return_value
        with patch.dict("sys.modules", {"wtpsplit": wtpsplit}):
            ja = wo.create_tokenizer("ja")
            ja.split("text")
            wtp.split.assert_called_with("text", lang_code="ja")
            ba = wo.create_tokenizer("ba")
            ba.split("more")
            wtp.split.assert_called_with("more", lang_code=None)
        wtpsplit.WtP.assert_called_with("wtp-canine-s-12l-no-adapters")


def _args(**overrides: Any) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    wo.add_shared_args(parser)
    args = parser.parse_args([])
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


class TestAsrFactory(unittest.TestCase):
    def test_shared_args_defaults(self):
        args = _args()
        self.assertEqual(args.min_chunk_size, 1.0)
        self.assertEqual(args.model, "large-v2")
        self.assertEqual(args.lan, "auto")
        self.assertEqual(args.backend, "faster-whisper")
        self.assertFalse(args.vac)
        self.assertEqual(args.buffer_trimming, "segment")
        self.assertEqual(args.log_level, "DEBUG")

    def test_openai_backend_with_vad_translate_and_sentences(self):
        args = _args(backend="openai-api", lan="de", vad=True, task="translate")
        args.buffer_trimming = "sentence"
        with (
            patch.object(wo, "OpenaiApiASR") as api,
            patch.object(wo, "create_tokenizer") as create,
        ):
            asr, online = wo.asr_factory(args, logfile=io.StringIO())
        api.assert_called_once_with(lan="de")
        asr.use_vad.assert_called_once_with()
        asr.set_translate_task.assert_called_once_with()
        create.assert_called_once_with("en")
        self.assertIsInstance(online, OnlineASRProcessor)
        self.assertIs(online.tokenizer, create.return_value)
        self.assertEqual(online.buffer_trimming_way, "sentence")

    def test_local_backends(self):
        for backend, name in (
            ("faster-whisper", "FasterWhisperASR"),
            ("mlx-whisper", "MLXWhisper"),
            ("whisper_timestamped", "WhisperTimestampedASR"),
        ):
            with self.subTest(backend=backend):
                args = _args(backend=backend, lan="en", model="tiny")
                with patch.object(wo, name) as cls:
                    asr, online = wo.asr_factory(args)
                cls.assert_called_once_with(
                    modelsize="tiny", lan="en", cache_dir=None, model_dir=None
                )
                asr.use_vad.assert_not_called()
                self.assertIsNone(online.tokenizer)

    def test_vac_wraps_processor(self):
        args = _args(vac=True, min_chunk_size=0.5)
        with (
            patch.object(wo, "FasterWhisperASR") as cls,
            patch.object(wo, "VACOnlineASRProcessor") as vac,
        ):
            asr, online = wo.asr_factory(args)
        self.assertIs(online, vac.return_value)
        self.assertEqual(vac.call_args.args, (0.5, cls.return_value, None))
        self.assertEqual(vac.call_args.kwargs["buffer_trimming"], ("segment", 15))

    def test_set_logging(self):
        target = logging.getLogger("fork_cov_whisper_target")
        server = logging.getLogger("whisper_online_test")
        self.addCleanup(target.setLevel, target.level)
        self.addCleanup(server.setLevel, server.level)
        with patch.object(wo.logging, "basicConfig") as basic:
            wo.set_logging(_args(log_level="ERROR"), target, other="_test")
        basic.assert_called_once()
        self.assertEqual(target.level, logging.ERROR)
        self.assertEqual(server.level, logging.ERROR)


class TestMainEntryPoint(unittest.TestCase):
    """Run the module as a script against a fake faster-whisper backend."""

    def _fake_faster_whisper(self, fail_first: bool = False) -> MagicMock:
        faster = MagicMock()
        segment = SimpleNamespace(
            end=0.5,
            no_speech_prob=0.0,
            words=[SimpleNamespace(word="hi", start=0.0, end=0.5)],
        )
        pipeline = faster.BatchedInferencePipeline.return_value
        effects: list[Any] = [([segment], None)] * 50
        if fail_first:
            # warm up succeeds, the first processing step asserts
            effects = [([segment], None), AssertionError("bad")] + effects
        pipeline.transcribe.side_effect = effects
        return faster

    def _run(self, argv: list[str], faster: MagicMock, clock: Any = None) -> str:
        audio = _audio(2.5)
        out = io.StringIO()
        err = io.StringIO()
        librosa = SimpleNamespace(load=MagicMock(return_value=(audio, SR)))
        modules: dict[str, Any] = {"faster_whisper": faster, "librosa": librosa}
        torch = MagicMock()
        torch.hub.load.return_value = ("vad", None)
        modules["torch"] = torch
        modules["silero_vad_iterator"] = SimpleNamespace(FixedVADIterator=FakeVAD)
        main_logger = logging.getLogger("__main__")
        server_logger = logging.getLogger("whisper_online_server")
        self.addCleanup(main_logger.setLevel, main_logger.level)
        self.addCleanup(server_logger.setLevel, server_logger.level)
        patches = [
            patch.dict("sys.modules", modules),
            patch.object(sys, "argv", ["whisper_online.py", "clip.wav", *argv]),
            patch.object(sys, "stdout", out),
            patch.object(sys, "stderr", err),
            patch("logging.basicConfig"),
            patch("time.sleep"),
        ]
        if clock is not None:
            patches.append(patch("time.time", side_effect=clock))
        for p in patches:
            p.start()
        try:
            runpy.run_path(wo.__file__, run_name="__main__")
        finally:
            for p in reversed(patches):
                p.stop()
        return out.getvalue()

    def test_offline_and_comp_unaware_conflict_exits(self):
        with (
            self.assertRaises(SystemExit) as ctx,
            self.assertLogs("__main__", level="ERROR") as logs,
        ):
            self._run(
                ["--offline", "--comp_unaware", "--log-level", "CRITICAL"],
                self._fake_faster_whisper(),
            )
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("not both", logs.output[0])

    def test_offline_mode_prints_final_transcript(self):
        out = self._run(
            ["--offline", "--lan", "en", "--log-level", "CRITICAL"],
            self._fake_faster_whisper(),
        )
        # first pass only buffers the hypothesis, finish flushes it
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].endswith(" 0 500 hi"))

    def test_offline_mode_assertion_is_logged(self):
        out = self._run(
            ["--offline", "--log-level", "CRITICAL"],
            self._fake_faster_whisper(fail_first=True),
        )
        self.assertEqual(out, "")

    def test_offline_vac_mode(self):
        out = self._run(
            ["--offline", "--vac", "--log-level", "CRITICAL"],
            self._fake_faster_whisper(),
        )
        self.assertEqual(out, "")

    def test_comp_unaware_mode_emits_committed_text(self):
        out = self._run(
            ["--comp_unaware", "--min-chunk-size", "1.0", "--log-level", "CRITICAL"],
            self._fake_faster_whisper(fail_first=True),
        )
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1)
        # emitted at the 3rd chunk end, 2.5 s, which is printed in milliseconds
        self.assertEqual(lines[0], "2500.0000 0 500 hi")

    def test_simultaneous_mode_uses_clock(self):
        ticks = iter(np.arange(0.0, 1000.0, 0.75).tolist())
        out = self._run(
            ["--log-level", "CRITICAL"],
            self._fake_faster_whisper(fail_first=True),
            clock=lambda: next(ticks),
        )
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].endswith(" 0 500 hi"))


if __name__ == "__main__":
    unittest.main()
