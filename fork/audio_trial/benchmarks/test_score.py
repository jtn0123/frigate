"""Reference scoring must count errors consistently and preserve real words."""

import unittest

from score import distance, normalize, summarize


class ScoreTests(unittest.TestCase):
    def test_insert_delete_substitute_and_exact_match(self):
        self.assertEqual(distance("a b c".split(), "a x c d".split()), 2)
        self.assertEqual(distance([], ["a"]), 1)
        self.assertEqual(distance(["a"], []), 1)
        self.assertEqual(distance(list("سلام"), list("سلام")), 0)

    def test_unicode_and_punctuation_normalization(self):
        self.assertEqual(normalize("HELLO,  world!"), "hello world")
        self.assertEqual(normalize("سَلَام"), "سلام")
        self.assertNotEqual(normalize("yes"), normalize("no"))


MANIFEST = {
    "clips": [
        {
            "id": "fa-1",
            "language": "fa",
            "reference": "یک دو سه",
            "english_reference": "one two three",
        },
        {
            "id": "fa-2",
            "language": "fa",
            "reference": "یک دو سه",
            "english_reference": "one two three",
        },
    ]
}

RESULTS = {
    "model": "medium",
    "load_seconds": 4.0,
    "peak_rss_mib": 900,
    "clips": [
        {
            "id": "fa-1",
            "transcribe": {"text": "یک دو سه", "seconds": 1.0},
            "translate": {"text": "one two three", "seconds": 1.0},
            "audio_seconds": 10.0,
        },
        {
            "id": "fa-2",
            "variant": "noisy",
            "transcribe": {"text": "یک دو", "seconds": 2.0},
            "translate": {"text": "one two", "seconds": 2.0},
            "audio_seconds": 10.0,
        },
    ],
}


class SummarizeTests(unittest.TestCase):
    """Rates are weighted by reference length, not averaged over clips."""

    def setUp(self):
        self.report = summarize(MANIFEST, RESULTS)

    def test_clean_and_noisy_variants_are_separate_groups(self):
        self.assertEqual(sorted(self.report["groups"]), ["fa/clean", "fa/noisy"])

    def test_a_perfect_clip_scores_zero(self):
        clean = self.report["groups"]["fa/clean"]
        self.assertEqual(clean["wer_percent"], 0)
        self.assertEqual(clean["cer_percent"], 0)
        self.assertEqual(clean["translation_reference_edit_percent"], 0)

    def test_a_missing_word_is_one_edit_over_the_reference_length(self):
        noisy = self.report["groups"]["fa/noisy"]
        self.assertEqual(noisy["words"], 3)
        self.assertEqual(noisy["word_edits"], 1)
        self.assertAlmostEqual(noisy["wer_percent"], 100 / 3)

    def test_real_time_factor_uses_both_stages(self):
        self.assertAlmostEqual(
            self.report["groups"]["fa/clean"]["real_time_factor"], 0.2
        )

    def test_run_metadata_is_carried_through(self):
        self.assertEqual(self.report["model"], "medium")
        self.assertEqual(self.report["load_seconds"], 4.0)
        self.assertEqual(self.report["peak_rss_mib"], 900)
        self.assertIn("paraphrases", self.report["translation_caveat"])
