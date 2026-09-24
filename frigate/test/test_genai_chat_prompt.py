"""Tests for the GenAI chat system prompt builder."""

import unittest
from types import SimpleNamespace

from frigate.config.ui import UnitSystemEnum
from frigate.genai.prompts import build_chat_system_prompt


def _zone(name: str, distances: list | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        distances=distances or [],
        get_formatted_name=lambda zone_id: name,
    )


def _config(unit_system=UnitSystemEnum.metric) -> SimpleNamespace:
    return SimpleNamespace(
        cameras={
            "back_deck_cam": SimpleNamespace(
                friendly_name="Back Deck Camera",
                zones={"front_walk": _zone("Front Walkway", distances=[1, 2])},
            ),
            "garage": SimpleNamespace(friendly_name=None, zones={}),
        },
        ui=SimpleNamespace(unit_system=unit_system),
    )


class TestChatSystemPrompt(unittest.TestCase):
    def test_semantic_routing_only_when_semantic_search_is_enabled(self):
        without = build_chat_system_prompt(_config(), [], False, [])
        with_semantic = build_chat_system_prompt(_config(), [], True, [])

        # named entity routing always points at the categorized names tool
        self.assertIn("Call get_categorized_object_names first", without)
        self.assertNotIn("set `semantic_query`", without)
        self.assertIn("set `semantic_query` with the descriptive phrase", with_semantic)

    def test_attribute_classification_models_are_listed(self):
        prompt = build_chat_system_prompt(
            _config(),
            [],
            False,
            [
                {"name": "delivery_uniform", "objects": ["person"]},
                {"name": "color", "objects": []},
            ],
        )

        self.assertIn("Configured attribute classification models:", prompt)
        self.assertIn("- delivery_uniform: applies to person", prompt)
        self.assertIn("- color: applies to any object", prompt)

    def test_no_attribute_section_without_models(self):
        prompt = build_chat_system_prompt(_config(), [], False, [])
        self.assertNotIn("Configured attribute classification models", prompt)

    def test_allowed_cameras_zones_and_speed_units(self):
        prompt = build_chat_system_prompt(
            _config(UnitSystemEnum.imperial),
            ["back_deck_cam", "garage", "deleted_cam"],
            False,
            [],
        )

        self.assertIn(
            "  - Back Deck Camera (ID: back_deck_cam, zones: Front Walkway "
            "(ID: front_walk))",
            prompt,
        )
        self.assertIn("  - Garage (ID: garage)", prompt)
        self.assertNotIn("deleted_cam", prompt)
        self.assertIn("Report object speeds to the user in mph.", prompt)

    def test_no_camera_or_speed_sections_without_allowed_cameras(self):
        prompt = build_chat_system_prompt(_config(), [], False, [])

        self.assertNotIn("Available cameras:", prompt)
        self.assertNotIn("Report object speeds", prompt)


if __name__ == "__main__":
    unittest.main()
