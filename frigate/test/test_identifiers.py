"""Identifier generation keeps stored ID formats stable."""

import string
from unittest import TestCase
from unittest.mock import patch

from frigate.util.identifiers import random_id


class TestIdentifiers(TestCase):
    def test_existing_identifier_lengths_and_alphabet(self):
        for length in (0, 6, 12):
            with self.subTest(length=length):
                result = random_id(length)
                self.assertEqual(len(result), length)
                self.assertTrue(
                    set(result) <= set(string.ascii_lowercase + string.digits)
                )

    def test_each_character_uses_secure_choice(self):
        with patch(
            "frigate.util.identifiers.secrets.choice", side_effect=list("a1b2c3")
        ) as choose:
            self.assertEqual(random_id(), "a1b2c3")
        self.assertEqual(choose.call_count, 6)
        choose.assert_called_with(string.ascii_lowercase + string.digits)
