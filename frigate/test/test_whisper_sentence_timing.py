"""Sentence boundaries and VAC resets preserve transcription timing."""

import unittest
from unittest.mock import Mock

from frigate.data_processing.real_time.whisper_online import (
    OnlineASRProcessor,
    VACOnlineASRProcessor,
)


class TestWhisperSentenceTiming(unittest.TestCase):
    def test_single_word_sentence_is_not_dropped(self):
        tokenizer = Mock()
        tokenizer.split.return_value = ["Hello.", "Good morning."]
        processor = OnlineASRProcessor(Mock(), tokenizer=tokenizer)
        words = [(1, 2, "Hello."), (3, 4, "Good"), (4, 5, "morning.")]
        self.assertEqual(
            processor.words_to_sentences(words),
            [(1, 2, "Hello."), (3, 5, "Good morning.")],
        )

    def test_vac_reset_accepts_offset_from_processor_interface(self):
        processor = object.__new__(VACOnlineASRProcessor)
        processor.online = Mock()
        processor.vac = Mock()
        processor.init(offset=12.5)
        processor.online.init.assert_called_once_with(offset=12.5)
        processor.vac.reset_states.assert_called_once_with()
        self.assertEqual(processor.audio_buffer.size, 0)
