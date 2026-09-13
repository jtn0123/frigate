"""Reference scoring must count errors consistently and preserve real words."""

import unittest

from score import distance, normalize


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
