"""Tests for drafting dataset classes from descriptions (fork I41)."""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from frigate.fork import classification_suggestions as suggest

TYPES = ["car", "van", "suv", "pickup", "box_truck", "none"]
COLORS = ["white", "black", "gray", "red", "blue"]
CARRIERS = ["ups", "fedex", "usps", "amazon", "none"]


def choice(winner: str, classes: list[str], score: float = 1.0) -> dict[str, Any]:
    """A Decisions answer that puts `score` on the winner and the rest on unknown."""
    names = [*suggest.candidate_classes(classes), suggest.UNKNOWN]
    probabilities = {name: 0.0 for name in names}
    probabilities[winner] = score
    probabilities[suggest.UNKNOWN] += round(1 - score, 6)
    return {
        "answers": {
            "category": {
                "type": "choice",
                "choice": max(probabilities, key=probabilities.__getitem__),
                "probabilities": probabilities,
            }
        }
    }


def event(description: str | None, camera: str = "yard", id: str = "one") -> dict:
    return {
        "id": id,
        "camera": camera,
        "label": "car",
        "data": {"description": description} if description is not None else {},
    }


class TestTextSuggestion(unittest.TestCase):
    def draft(self, text: str, classes: list[str]) -> str | None:
        result = suggest.text_suggestion(text, classes)
        return result["category"] if result else None

    def test_explicit_type_and_color(self):
        self.assertEqual(self.draft("A white van is parked.", TYPES), "van")
        self.assertEqual(self.draft("A white van is parked.", COLORS), "white")

    def test_longest_phrase_wins_and_falls_back_to_broad_class(self):
        self.assertEqual(self.draft("A pickup truck drives by.", TYPES), "pickup")
        self.assertEqual(self.draft("A box truck backs in.", TYPES), "box_truck")
        # With only the detector's labels as classes, a pickup truck is a truck.
        self.assertEqual(
            self.draft("A pickup truck drives by.", ["car", "truck"]), "truck"
        )

    def test_synonyms_and_folder_spellings(self):
        self.assertEqual(self.draft("A silver crossover pulls in.", TYPES), "suv")
        self.assertEqual(self.draft("A silver crossover pulls in.", COLORS), "gray")
        self.assertEqual(
            self.draft("A box truck backs in.", ["Box Truck", "Van"]), "Box Truck"
        )

    def test_color_needs_a_vehicle_noun(self):
        self.assertIsNone(self.draft("A person in a red jacket walks by.", COLORS))
        self.assertIsNone(self.draft("The car is near a white fence.", COLORS))
        self.assertEqual(self.draft("A dark red parked sedan.", COLORS), "red")

    def test_none_is_never_suggested(self):
        self.assertIsNone(self.draft("There is none here.", ["open", "none"]))

    def test_hedged_negated_and_multi_subject_text_abstains(self):
        for text in (
            "This could be a van.",
            "Probably a white SUV.",
            "No car is visible. A black pickup is parked.",
            "It is not a van, it is a sedan.",
            "A car is parked while another van passes.",
            "Two vans are parked.",
            "A black pickup is parked in front of a white SUV.",
            "A red sedan is beside a white sedan.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(self.draft(text, TYPES), text)
                self.assertIsNone(self.draft(text, COLORS), text)

    def test_carrier_needs_the_vehicle_not_the_person(self):
        self.assertEqual(self.draft("A UPS delivery truck stops.", CARRIERS), "ups")
        self.assertEqual(
            self.draft("A brown van with a UPS logo on the side.", CARRIERS), "ups"
        )
        self.assertIsNone(
            self.draft(
                "A person with a UPS logo on their shirt stands by a van.", CARRIERS
            )
        )
        self.assertIsNone(self.draft("A driver carries an Amazon package.", CARRIERS))
        self.assertIsNone(self.draft("A plain white van is parked.", CARRIERS))
        self.assertIsNone(self.draft("A van with no FedEx markings.", CARRIERS))
        self.assertIsNone(
            self.draft("A red car passes a truck with UPS branding.", CARRIERS)
        )

    def test_generic_classes_match_their_own_name(self):
        self.assertEqual(
            self.draft(
                "The garage door is half open.", ["open", "closed", "half-open"]
            ),
            "half-open",
        )
        self.assertIsNone(self.draft("The gate is not open.", ["open", "closed"]))
        self.assertIsNone(self.draft("A van is parked.", []))
        self.assertIsNone(self.draft("", TYPES))

    def test_evidence_is_the_matching_sentence(self):
        result = suggest.text_suggestion(
            "Nothing else. A white van is parked by the gate. Later it leaves.", TYPES
        )
        assert result is not None
        self.assertEqual(result["evidence"], "a white van is parked by the gate")
        self.assertEqual(result["source"], "text")
        self.assertIsNone(result["score"])


class TestJevContract(unittest.TestCase):
    def test_request_carries_only_the_text_and_every_class_plus_unknown(self):
        request = suggest.build_jev_request("A white van.", TYPES, "typesafe/jev-1.13")
        self.assertEqual(request["state"], {"description": "A white van."})
        criteria = request["questions"]["category"]["criteria"]
        self.assertEqual(
            set(criteria), {"car", "van", "suv", "pickup", "box_truck", "unknown"}
        )
        self.assertIn("box cargo body", criteria["box_truck"])
        self.assertIn("untrusted", request["questions"]["category"]["instructions"])

    def test_contract_hash_changes_with_classes_or_model_not_text(self):
        a = suggest.contract_hash(suggest.build_jev_request("x", TYPES, "m"))
        b = suggest.contract_hash(suggest.build_jev_request("y", TYPES, "m"))
        c = suggest.contract_hash(suggest.build_jev_request("x", COLORS, "m"))
        d = suggest.contract_hash(suggest.build_jev_request("x", TYPES, "m2"))
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertNotEqual(a, d)

    def test_parse_rejects_incomplete_or_invalid_distributions(self):
        good = choice("van", TYPES)
        answer = suggest.parse_jev_answer(good, TYPES)
        self.assertEqual(answer["choice"], "van")
        for bad in (
            None,
            {},
            {"answers": {"category": {"type": "noul", "noul": 0.9}}},
            {
                "answers": {
                    "category": {
                        "type": "choice",
                        "choice": "van",
                        "probabilities": {"van": 1},
                    }
                }
            },
            {
                "answers": {
                    "category": {
                        "type": "choice",
                        "choice": "car",
                        "probabilities": good["answers"]["category"]["probabilities"],
                    }
                }
            },
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    suggest.parse_jev_answer(bad, TYPES)
        broken = choice("van", TYPES)
        broken["answers"]["category"]["probabilities"]["van"] = float("nan")
        with self.assertRaises(ValueError):
            suggest.parse_jev_answer(broken, TYPES)
        unnormalized = choice("van", TYPES)
        unnormalized["answers"]["category"]["probabilities"]["car"] = 0.5
        with self.assertRaises(ValueError):
            suggest.parse_jev_answer(unnormalized, TYPES)
        boolean = choice("van", TYPES)
        boolean["answers"]["category"]["probabilities"]["van"] = True
        with self.assertRaises(ValueError):
            suggest.parse_jev_answer(boolean, TYPES)

    def test_gates_hold_back_unsure_answers(self):
        sure = suggest.parse_jev_answer(choice("van", TYPES, 0.95), TYPES)
        draft = suggest.jev_suggestion(sure)
        assert draft is not None
        self.assertEqual(draft["category"], "van")
        self.assertEqual(draft["source"], "jev")
        self.assertEqual(draft["score"], 0.95)
        self.assertIsNone(
            suggest.jev_suggestion(
                suggest.parse_jev_answer(choice("van", TYPES, 0.8), TYPES)
            )
        )
        self.assertIsNone(
            suggest.jev_suggestion(
                suggest.parse_jev_answer(choice(suggest.UNKNOWN, TYPES), TYPES)
            )
        )
        close = choice("van", TYPES, 0.9)
        close["answers"]["category"]["probabilities"]["suv"] = 0.1
        close["answers"]["category"]["probabilities"][suggest.UNKNOWN] = 0.0
        # 0.9 wins but only by 0.8: fine. Now make the runner-up 0.75 of a 1.65 sum.
        self.assertIsNotNone(
            suggest.jev_suggestion(suggest.parse_jev_answer(close, TYPES))
        )

    def test_choose_prefers_jev_but_never_a_contradicted_draft(self):
        text: suggest.Suggestion = {
            "category": "van",
            "source": "text",
            "score": None,
            "evidence": "a white van",
        }
        jev: suggest.Suggestion = {
            "category": "Van",
            "source": "jev",
            "score": 0.97,
            "evidence": "",
        }
        picked, conflict = suggest.choose(text, jev)
        self.assertFalse(conflict)
        assert picked is not None
        self.assertEqual(picked["source"], "jev")
        self.assertEqual(picked["evidence"], "a white van")
        picked, conflict = suggest.choose(text, {**jev, "category": "suv"})
        self.assertTrue(conflict)
        self.assertIsNone(picked)
        self.assertEqual(suggest.choose(None, jev), (jev, False))
        self.assertEqual(suggest.choose(text, None), (text, False))
        self.assertEqual(suggest.choose(None, None), (None, False))


class TestCacheAndBudget(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_cache_round_trips_by_text_and_contract(self):
        cache = suggest.SuggestionCache(self.root / "cache.sqlite")
        self.assertIsNone(cache.get("sha", "contract"))
        cache.put("sha", "contract", {"choice": "van", "probabilities": {"van": 1.0}})
        self.assertEqual(cache.get("sha", "contract")["choice"], "van")
        self.assertIsNone(cache.get("sha", "other"))
        self.assertEqual(cache.count(), 1)
        # A second handle on the same file sees the row.
        self.assertEqual(
            suggest.SuggestionCache(self.root / "cache.sqlite").get("sha", "contract")[
                "choice"
            ],
            "van",
        )

    def test_budget_counts_across_instances_and_stops_at_the_limit(self):
        budget = suggest.DailyBudget(self.root / "usage.json")
        self.assertEqual(budget.used(), 0)
        self.assertTrue(budget.reserve(2))
        self.assertTrue(suggest.DailyBudget(self.root / "usage.json").reserve(2))
        self.assertFalse(budget.reserve(2))
        self.assertEqual(budget.used(), 2)

    def test_budget_ignores_a_damaged_file(self):
        (self.root / "usage.json").write_text("not json")
        budget = suggest.DailyBudget(self.root / "usage.json")
        self.assertEqual(budget.used(), 0)
        self.assertTrue(budget.reserve(1))
        (self.root / "usage.json").write_text(
            json.dumps({"day": "1999-01-01", "count": 5})
        )
        self.assertEqual(budget.used(), 0)


class TestSuggestForEvents(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.cache = suggest.SuggestionCache(root / "cache.sqlite")
        self.budget = suggest.DailyBudget(root / "usage.json")
        self.jev: suggest.JevSettings = {
            "model": "typesafe/jev-1.13",
            "cameras": [],
            "daily_request_limit": 10,
        }
        self.calls: list[dict[str, Any]] = []

    def run_suggest(self, events, classes, ask, jev=None, text=True):
        return asyncio.run(
            suggest.suggest_for_events(
                events, classes, text, jev or self.jev, self.cache, self.budget, ask
            )
        )

    def test_text_only_when_jev_is_off(self):
        result = asyncio.run(
            suggest.suggest_for_events(
                [event("A white van.")], TYPES, True, None, None, None, None
            )
        )
        self.assertEqual(result["one"]["suggestion"]["category"], "van")
        self.assertEqual(result["one"]["jev_status"], "disabled")
        self.assertIsNone(result["one"]["jev"])

    def test_jev_answers_are_cached_and_only_asked_once(self):
        async def ask(request):
            self.calls.append(request)
            return choice("suv", TYPES, 0.96)

        events = [event("A gray crossover.")]
        first = self.run_suggest(events, TYPES, ask)
        second = self.run_suggest(events, TYPES, ask)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["state"], {"description": "A gray crossover."})
        self.assertNotIn("camera", json.dumps(self.calls[0]))
        for result in (first, second):
            self.assertEqual(result["one"]["suggestion"]["source"], "jev")
            self.assertEqual(result["one"]["suggestion"]["category"], "suv")
            self.assertEqual(result["one"]["jev_status"], "answered")
        self.assertEqual(self.budget.used(), 1)

    def test_jev_and_text_disagreeing_shows_nothing(self):
        async def ask(request):
            return choice("suv", TYPES, 0.96)

        result = self.run_suggest([event("A white van.")], TYPES, ask)
        self.assertTrue(result["one"]["conflict"])
        self.assertIsNone(result["one"]["suggestion"])
        self.assertEqual(result["one"]["text"]["category"], "van")
        self.assertEqual(result["one"]["jev"]["category"], "suv")

    def test_unknown_is_cached_but_errors_are_not(self):
        answers = [ValueError("boom"), choice(suggest.UNKNOWN, TYPES)]

        async def ask(request):
            self.calls.append(request)
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise suggest.JevError("provider")
            return answer

        events = [event("Something vague about the yard.")]
        self.assertEqual(
            self.run_suggest(events, TYPES, ask)["one"]["jev_status"], "error"
        )
        self.assertEqual(
            self.run_suggest(events, TYPES, ask)["one"]["jev_status"], "unknown"
        )
        self.assertEqual(
            self.run_suggest(events, TYPES, ask)["one"]["jev_status"], "unknown"
        )
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.budget.used(), 2)

    def test_budget_camera_and_missing_text_skip_the_provider(self):
        async def ask(request):
            self.calls.append(request)
            return choice("van", TYPES)

        allowed: suggest.JevSettings = {**self.jev, "cameras": ["front"]}
        result = self.run_suggest([event("A white van.")], TYPES, ask, allowed)
        self.assertEqual(result["one"]["jev_status"], "camera_not_allowed")
        self.assertEqual(result["one"]["suggestion"]["source"], "text")

        result = self.run_suggest([event(None), event("   ", id="two")], TYPES, ask)
        self.assertEqual(result["one"]["jev_status"], "no_description")
        self.assertEqual(result["two"]["jev_status"], "no_description")

        result = self.run_suggest([event("A white van.")], [], ask)
        self.assertEqual(result["one"]["jev_status"], "no_classes")
        self.assertEqual(self.calls, [])

        capped: suggest.JevSettings = {**self.jev, "daily_request_limit": 1}
        self.run_suggest(
            [event("A white van."), event("A red car.", id="two")], TYPES, ask, capped
        )
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(
            self.run_suggest([event("A blue suv.", id="three")], TYPES, ask, capped)[
                "three"
            ]["jev_status"],
            "budget",
        )

    def test_invalid_provider_answers_are_errors(self):
        async def ask(request):
            return {
                "answers": {
                    "category": {
                        "type": "choice",
                        "choice": "van",
                        "probabilities": {"van": 1},
                    }
                }
            }

        result = self.run_suggest([event("A white van.")], TYPES, ask)
        self.assertEqual(result["one"]["jev_status"], "error")
        self.assertEqual(self.cache.count(), 0)


class TestFilesAndProvenance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clips = self.tmp.name
        self.train = os.path.join(self.clips, "vehicle_type", "train")
        os.makedirs(self.train)
        image = np.zeros((8, 8, 3), dtype=np.uint8)
        for name in ("a.webp", "b.webp"):
            cv2.imwrite(os.path.join(self.train, name), image)

    def test_moves_files_into_the_class_and_records_why(self):
        moved = suggest.categorize_train_files(
            self.clips, "vehicle_type", "van", ["a.webp", "b.webp"]
        )
        self.assertEqual(len(moved), 2)
        for name in moved:
            self.assertTrue(name.startswith("van-") and name.endswith(".png"))
            self.assertTrue(
                os.path.isfile(
                    os.path.join(self.clips, "vehicle_type", "dataset", "van", name)
                )
            )
        self.assertEqual(os.listdir(self.train), [])
        suggest.record_confirmation(
            self.clips,
            "vehicle_type",
            {"event_id": "e1", "category": "van", "files": moved},
        )
        entries = suggest.read_provenance(self.clips, "vehicle_type")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["files"], moved)
        self.assertIn("time", entries[0])

    def test_rejects_missing_or_unsafe_files_before_moving_anything(self):
        with self.assertRaises(FileNotFoundError):
            suggest.categorize_train_files(
                self.clips, "vehicle_type", "van", ["a.webp", "missing.webp"]
            )
        with self.assertRaises(ValueError):
            suggest.categorize_train_files(self.clips, "vehicle_type", "van", [".."])
        self.assertEqual(sorted(os.listdir(self.train)), ["a.webp", "b.webp"])

    def test_read_provenance_skips_damaged_lines_and_missing_files(self):
        self.assertEqual(suggest.read_provenance(self.clips, "vehicle_type"), [])
        path = os.path.join(self.clips, "vehicle_type", suggest.PROVENANCE_FILE)
        with open(path, "w") as f:
            f.write('{"event_id": "e1"}\nnot json\n[1]\n')
        self.assertEqual(
            suggest.read_provenance(self.clips, "vehicle_type"), [{"event_id": "e1"}]
        )


if __name__ == "__main__":
    unittest.main()
