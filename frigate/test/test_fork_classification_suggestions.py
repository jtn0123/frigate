"""Tests for drafting dataset classes from descriptions (fork I41)."""

import asyncio
import json
import os
import shutil
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

    def test_hedging_in_another_sentence_does_not_block(self):
        text = "A silver SUV is parked on the driveway. The car appears stationary."
        self.assertEqual(self.draft(text, TYPES), "suv")
        self.assertEqual(self.draft(text, COLORS), "gray")
        self.assertIsNone(self.draft("The SUV appears to be parked.", TYPES))

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

    def test_a_group_with_no_files_left_was_already_filed(self):
        suggest.categorize_train_files(self.clips, "vehicle_type", "van", ["a.webp"])
        with self.assertRaises(suggest.AlreadyFiledError):
            suggest.categorize_train_files(
                self.clips, "vehicle_type", "van", ["a.webp"]
            )
        with self.assertRaises(FileNotFoundError) as raised:
            suggest.categorize_train_files(
                self.clips, "vehicle_type", "van", ["a.webp", "b.webp"]
            )
        self.assertNotIsInstance(raised.exception, suggest.AlreadyFiledError)
        self.assertEqual(os.listdir(self.train), ["b.webp"])

    def test_undo_moves_the_group_back_under_its_train_names(self):
        moved = suggest.file_train_images(
            self.clips,
            "vehicle_type",
            "van",
            ["a.webp", "b.webp"],
            {"event_id": "e1", "category": "van", "suggested_category": "van"},
        )
        entry = suggest.read_provenance(self.clips, "vehicle_type")[0]
        self.assertEqual(entry["files"], moved)
        self.assertEqual(entry["train_files"], ["a.webp", "b.webp"])
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "van")
        os.unlink(os.path.join(dataset, moved[1]))

        restored = suggest.restore_train_files(
            self.clips, "vehicle_type", "e1", "van", [moved[0], moved[1]]
        )

        self.assertEqual(restored, [moved[0]], "files already gone are skipped")
        self.assertEqual(os.listdir(self.train), ["a.webp"])
        self.assertEqual(os.listdir(dataset), [])
        undo = suggest.read_provenance(self.clips, "vehicle_type")[-1]
        self.assertEqual(
            {k: v for k, v in undo.items() if k != "time"},
            {"event_id": "e1", "category": "van", "undo": True, "files": [moved[0]]},
        )
        self.assertIsInstance(undo["time"], float)

    def test_undo_without_a_recorded_train_name_groups_under_the_event(self):
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "van")
        os.makedirs(dataset)
        cv2.imwrite(
            os.path.join(dataset, "van-1.png"), np.zeros((8, 8, 3), dtype=np.uint8)
        )
        with open(os.path.join(dataset, "van-2.png"), "w") as f:
            f.write("not an image")
        restored = suggest.restore_train_files(
            self.clips, "vehicle_type", "evt-1", "van", ["van-1.png", "van-2.png"]
        )
        self.assertEqual(restored, ["van-1.png"], "an unreadable file stays put")
        self.assertEqual(os.listdir(dataset), ["van-2.png"])
        self.assertEqual(
            len(suggest.train_files_for_event(self.clips, "vehicle_type", "evt-1")), 1
        )

    def test_undo_rejects_paths_and_unsafe_event_ids(self):
        for files in (["../a.webp"], ["sub/a.png"], ["a..png"], [""]):
            with self.assertRaises(ValueError):
                suggest.restore_train_files(
                    self.clips, "vehicle_type", "e1", "van", files
                )
        with self.assertRaises(ValueError):
            suggest.restore_train_files(
                self.clips, "vehicle_type", "../e1", "van", ["van-1.png"]
            )
        self.assertEqual(suggest.read_provenance(self.clips, "vehicle_type"), [])

    def test_read_provenance_skips_damaged_lines_and_missing_files(self):
        self.assertEqual(suggest.read_provenance(self.clips, "vehicle_type"), [])
        path = os.path.join(self.clips, "vehicle_type", suggest.PROVENANCE_FILE)
        with open(path, "w") as f:
            f.write('{"event_id": "e1"}\nnot json\n[1]\n')
        self.assertEqual(
            suggest.read_provenance(self.clips, "vehicle_type"), [{"event_id": "e1"}]
        )


class TestSummarizeProvenance(unittest.TestCase):
    def entry(self, **overrides: Any) -> dict[str, Any]:
        base = {
            "time": 100.0,
            "event_id": "e1",
            "camera": "front",
            "category": "van",
            "suggested_category": "van",
            "source": "jev",
            "score": 0.95,
            "accepted": True,
            "files": ["van-1.png"],
        }
        return {**base, **overrides}

    def test_empty_file_reports_no_rate(self):
        report = suggest.summarize_provenance([])
        self.assertEqual(report["total"], 0)
        self.assertIsNone(report["rate"])
        self.assertEqual(report["sources"], {})
        self.assertIsNone(report["first_time"])

    def test_counts_per_source_class_and_camera(self):
        entries = [
            self.entry(),
            self.entry(time=200.0, category="suv", accepted=False),
            self.entry(time=300.0, source="text", score=None, camera="back"),
            self.entry(
                time=400.0,
                suggested_category="suv",
                category="pickup",
                accepted=False,
                camera="back",
            ),
        ]

        report = suggest.summarize_provenance(entries)

        self.assertEqual((report["total"], report["accepted"]), (4, 2))
        self.assertEqual(report["rate"], 0.5)
        self.assertEqual(
            report["sources"]["jev"], {"total": 3, "accepted": 1, "rate": 1 / 3}
        )
        self.assertEqual(
            report["sources"]["text"], {"total": 1, "accepted": 1, "rate": 1.0}
        )
        self.assertEqual(
            report["classes"]["van"],
            {
                "total": 3,
                "accepted": 2,
                "rate": 2 / 3,
                "corrected_to": {"suv": 1},
                "auto_filed": 0,
                "bulk_accepted": 0,
            },
        )
        self.assertEqual(report["classes"]["suv"]["corrected_to"], {"pickup": 1})
        self.assertEqual(report["cameras"]["back"]["total"], 2)
        self.assertEqual((report["first_time"], report["last_time"]), (100.0, 400.0))

    def test_bulk_accepts_are_counted_apart_from_the_rate(self):
        entries = [
            self.entry(),
            self.entry(event_id="e2", bulk=True),
            self.entry(event_id="e3", bulk=True, suggested_category="suv"),
            self.entry(event_id="e4", category="suv", accepted=False, bulk=False),
        ]
        report = suggest.summarize_provenance(entries)
        self.assertEqual((report["total"], report["accepted"]), (2, 1))
        self.assertEqual(report["bulk_accepted"], 2)
        self.assertEqual(report["classes"]["van"]["bulk_accepted"], 1)
        self.assertEqual(report["classes"]["suv"]["bulk_accepted"], 1)
        self.assertEqual(report["classes"]["suv"]["total"], 0)
        self.assertEqual(report["sources"]["jev"]["total"], 2)
        self.assertEqual(suggest.kept_rate(entries, "van"), (0.5, 2))

    def test_undone_confirmations_leave_every_count(self):
        undo = {"event_id": "e1", "category": "van", "undo": True, "files": []}
        entries = [
            self.entry(),
            self.entry(event_id="e2"),
            self.entry(event_id="e1", category="suv", accepted=False),
            undo,
            # Filed again after the undo, so this one counts.
            self.entry(event_id="e1", category="suv", accepted=False, time=500.0),
        ]
        report = suggest.summarize_provenance(entries)
        self.assertEqual(report["undone"], 1)
        self.assertEqual((report["total"], report["accepted"]), (3, 1))
        self.assertEqual(suggest.kept_rate(entries, "van"), (1 / 3, 3))
        self.assertEqual(
            suggest.active_entries([self.entry(), undo]), ([], 1), "undo line dropped"
        )

    def test_ignores_lines_without_a_suggested_class(self):
        entries = [
            self.entry(suggested_category=None, source=None),
            {"garbage": True},
            self.entry(source=None),
        ]
        report = suggest.summarize_provenance(entries)
        self.assertEqual(report["total"], 1)
        self.assertEqual(list(report["sources"]), ["none"])


class TestModelCheck(unittest.TestCase):
    def test_verdict_comes_from_the_right_field_and_must_be_a_class(self):
        classes = ["sedan", "suv", "none"]
        row = {"sub_label": "SUV", "data": {"vehicle_type": "sedan"}}
        self.assertEqual(
            suggest.model_verdict("vehicle_type", "sub_label", classes, row), "suv"
        )
        self.assertEqual(
            suggest.model_verdict("vehicle_type", "attribute", classes, row), "sedan"
        )
        self.assertIsNone(
            suggest.model_verdict(
                "vehicle_type", "sub_label", classes, {"sub_label": "Bob"}
            )
        )
        self.assertIsNone(
            suggest.model_verdict("vehicle_type", "attribute", classes, {"data": None})
        )
        self.assertIsNone(
            suggest.model_verdict(
                "vehicle_type", "sub_label", classes, {"sub_label": "none"}
            )
        )

    def test_summary_counts_agreement_and_lists_disagreements_newest_first(self):
        entries = [
            {
                "time": 1,
                "event_id": "a",
                "camera": "yard",
                "model_said": "suv",
                "draft": "suv",
                "agree": True,
            },
            {
                "time": 2,
                "event_id": "b",
                "camera": "yard",
                "model_said": "suv",
                "draft": "sedan",
                "agree": False,
            },
            {
                "time": 3,
                "event_id": "c",
                "camera": "door",
                "model_said": "van",
                "draft": "suv",
                "agree": False,
            },
            {"garbage": True},
        ]
        report = suggest.summarize_model_checks(entries)
        self.assertEqual((report["total"], report["accepted"]), (3, 1))
        self.assertEqual(report["classes"]["suv"]["corrected_to"], {"sedan": 1})
        self.assertEqual(report["classes"]["suv"]["rate"], 0.5)
        self.assertEqual(
            [d["event_id"] for d in report["recent_disagreements"]], ["c", "b"]
        )
        self.assertEqual(report["recent_disagreements"][0]["model_said"], "van")
        self.assertIsNone(suggest.summarize_model_checks([])["rate"])


if __name__ == "__main__":
    unittest.main()


class TestDatasetGuards(unittest.TestCase):
    """The guards that keep auto-filing from making the dataset worse (I48 to I54)."""

    def setUp(self):
        self.clips = tempfile.mkdtemp()
        self.name = "vehicle_type"
        self.train = os.path.join(self.clips, self.name, "train")
        os.makedirs(self.train)

    def tearDown(self):
        shutil.rmtree(self.clips, ignore_errors=True)

    def _image(self, folder: str, name: str, size: int = 120) -> None:
        os.makedirs(folder, exist_ok=True)
        cv2.imwrite(os.path.join(folder, name), np.zeros((size, size, 3), np.uint8))

    def test_train_file_names_carry_the_model_verdict(self):
        self.assertEqual(
            suggest.train_file_verdict("1780.5-abc-1781.0-mail_truck-0.97.webp"),
            ("mail_truck", 0.97),
        )
        self.assertIsNone(suggest.train_file_verdict("odd-name.webp"))
        self.assertIsNone(suggest.train_file_verdict("a-b-c-d-e.webp"))
        files = [
            "e-1-1.0-suv-0.95.webp",
            "e-1-2.0-suv-0.5.webp",
            "e-1-3.0-sedan-0.99.webp",
            "e-1-4.0-unknown-0.0.webp",
        ]
        self.assertEqual(
            suggest.sure_train_files(files, "SUV", 0.9), ["e-1-1.0-suv-0.95.webp"]
        )
        self.assertEqual(suggest.sure_train_files(files, "van", 0.9), [])

    def test_train_files_are_grouped_by_event_with_one_listdir(self):
        for name in ("e-1-1.0-x-0.0.webp", "e-1-2.0-x-0.0.webp", "e-10-1.0-x-0.0.webp"):
            self._image(self.train, name)
        self._image(self.train, "not-a-train-file.png")
        self.assertEqual(
            suggest.train_files_by_event(self.clips, self.name, ["e-1", "e-2"]),
            {"e-1": ["e-1-1.0-x-0.0.webp", "e-1-2.0-x-0.0.webp"], "e-2": []},
        )
        self.assertEqual(
            suggest.train_files_by_event(self.clips, "nope", ["e"]), {"e": []}
        )

    def test_tiny_crops_are_found_by_reading_the_image(self):
        self._image(self.train, "e-1-1.0-x-0.0.webp", size=120)
        self._image(self.train, "e-1-2.0-x-0.0.webp", size=99)
        with open(os.path.join(self.train, "e-1-3.0-x-0.0.webp"), "wb") as f:
            f.write(b"not an image")
        files = [
            "e-1-1.0-x-0.0.webp",
            "e-1-2.0-x-0.0.webp",
            "e-1-3.0-x-0.0.webp",
            "gone",
        ]
        self.assertEqual(
            suggest.too_small_train_files(self.clips, self.name, files),
            ["e-1-2.0-x-0.0.webp"],
        )
        self.assertIsNone(
            suggest.image_size(os.path.join(self.train, "e-1-3.0-x-0.0.webp"))
        )

    def test_auto_file_waits_per_camera(self):
        now = 1_000_000.0
        entries = [
            {"auto": True, "camera": "front", "category": "suv", "time": now - 600},
            {"auto": True, "camera": "front", "category": "suv", "time": now - 90_000},
            {"auto": False, "camera": "front", "category": "suv", "time": now - 10},
            {"auto": True, "camera": "front", "category": "van", "time": now - 10},
            {"auto": True, "camera": "front", "category": "suv"},
        ]
        wait = suggest.auto_file_wait
        self.assertEqual(wait(entries, "suv", "front", now, 3600, 10), "cooldown")
        self.assertIsNone(wait(entries, "suv", "front", now, 300, 10))
        self.assertEqual(wait(entries, "suv", "front", now, 300, 1), "daily_limit")
        self.assertIsNone(wait(entries, "suv", "side", now, 3600, 1))
        self.assertIsNone(wait(entries, "sedan", "front", now, 3600, 1))

    def test_dataset_balance_flags_a_class_over_three_times_the_smallest(self):
        dataset = os.path.join(self.clips, self.name, "dataset")
        for i in range(7):
            self._image(os.path.join(dataset, "suv"), f"suv-{i}.png", size=8)
        for i in range(2):
            self._image(os.path.join(dataset, "sedan"), f"sedan-{i}.png", size=8)
        os.makedirs(os.path.join(dataset, "none"))
        with open(os.path.join(dataset, "suv", "notes.txt"), "w") as f:
            f.write("ignored")
        counts = suggest.dataset_counts(self.clips, self.name)
        self.assertEqual(counts, {"none": 0, "sedan": 2, "suv": 7})
        balance = suggest.dataset_balance(counts)
        self.assertEqual(
            balance,
            {
                "classes": counts,
                "empty": ["none"],
                "largest": "suv",
                "smallest": "sedan",
                "ratio": 3.5,
                "lopsided": True,
            },
        )
        self.assertFalse(suggest.dataset_balance({"a": 3, "b": 1})["lopsided"])
        self.assertIsNone(suggest.dataset_balance({"a": 3})["ratio"])
        self.assertEqual(suggest.dataset_counts(self.clips, "nope"), {})
        self.assertTrue(suggest.would_unbalance({"a": 3, "b": 1}, "a", 1))
        self.assertFalse(suggest.would_unbalance({"a": 3, "b": 1}, "b", 1))
        self.assertFalse(suggest.would_unbalance({"a": 1, "b": 1}, "a", 2))
        self.assertFalse(suggest.would_unbalance({}, "a", 5), "nothing to compare")

    def test_training_gap_reads_upstream_metadata(self):
        counts = {"suv": 4, "sedan": 3}
        self.assertEqual(
            suggest.training_gap(self.clips, self.name, counts),
            {
                "has_trained": False,
                "last_training_date": None,
                "current_images": 7,
                "new_images": 7,
            },
        )
        path = os.path.join(self.clips, self.name, suggest.TRAINING_METADATA_FILE)
        with open(path, "w") as f:
            json.dump(
                {
                    "last_training_date": "2026-09-20T10:00:00",
                    "last_training_image_count": 5,
                },
                f,
            )
        gap = suggest.training_gap(self.clips, self.name, counts)
        self.assertEqual((gap["has_trained"], gap["new_images"]), (True, 2))
        self.assertEqual(gap["last_training_date"], "2026-09-20T10:00:00")
        with open(path, "w") as f:
            f.write("{broken")
        self.assertFalse(
            suggest.training_gap(self.clips, self.name, counts)["has_trained"]
        )

    def test_spot_check_lists_unchecked_auto_files_and_records_the_verdict(self):
        dataset = os.path.join(self.clips, self.name, "dataset", "suv")
        for name in ("suv-a.png", "suv-b.png", "suv-c.png"):
            self._image(dataset, name, size=8)
        record = suggest.record_confirmation
        record(
            self.clips,
            self.name,
            {
                "event_id": "e-1",
                "camera": "front",
                "category": "suv",
                "suggested_category": "suv",
                "source": "jev",
                "score": 0.97,
                "accepted": True,
                "auto": True,
                "description_sha256": "abc",
                "files": ["suv-a.png", "suv-b.png"],
            },
        )
        record(
            self.clips,
            self.name,
            {
                "event_id": "e-2",
                "category": "suv",
                "suggested_category": "suv",
                "accepted": True,
                "auto": True,
                "files": ["gone.png"],
            },
        )
        record(
            self.clips,
            self.name,
            {
                "event_id": "e-3",
                "category": "suv",
                "suggested_category": "suv",
                "accepted": True,
                "auto": True,
                "files": ["suv-c.png"],
            },
        )
        record(
            self.clips,
            self.name,
            {
                "event_id": "e-4",
                "category": "suv",
                "suggested_category": "suv",
                "accepted": True,
                "files": ["suv-c.png"],
            },
        )
        entries = suggest.read_provenance(self.clips, self.name)
        recent = suggest.recent_auto_filed(self.clips, self.name, entries)
        self.assertEqual(
            [r["event_id"] for r in recent],
            ["e-3", "e-1"],
            "newest first, files on disk only",
        )
        self.assertEqual(recent[1]["files"], ["suv-a.png", "suv-b.png"])
        self.assertEqual(recent[1]["source"], "jev")
        self.assertEqual(
            suggest.recent_auto_filed(self.clips, self.name, entries, limit=1)[0][
                "event_id"
            ],
            "e-3",
        )

        self.assertEqual(
            suggest.spot_check(
                self.clips, self.name, "e-3", "suv", ["suv-c.png"], True
            ),
            [],
        )
        self.assertTrue(os.path.isfile(os.path.join(dataset, "suv-c.png")))
        removed = suggest.spot_check(
            self.clips,
            self.name,
            "e-1",
            "suv",
            ["suv-a.png", "suv-b.png", "missing.png"],
            False,
        )
        self.assertEqual(removed, ["suv-a.png", "suv-b.png"])
        self.assertEqual(sorted(os.listdir(dataset)), ["suv-c.png"])

        entries = suggest.read_provenance(self.clips, self.name)
        self.assertEqual(suggest.recent_auto_filed(self.clips, self.name, entries), [])
        kept, rejected = entries[-2], entries[-1]
        self.assertEqual(
            (kept["accepted"], kept["category"], kept["spot_check"]),
            (True, "suv", True),
        )
        self.assertEqual((rejected["accepted"], rejected["category"]), (False, None))
        self.assertEqual(
            (rejected["source"], rejected["score"], rejected["camera"]),
            ("jev", 0.97, "front"),
        )
        self.assertEqual(rejected["description_sha256"], "abc")
        # Both verdicts count as reviewed drafts of the class, so a class that
        # keeps failing its spot checks loses its auto-file rate.
        self.assertEqual(suggest.kept_rate(entries, "suv"), (2 / 3, 3))
        with self.assertRaises(ValueError):
            suggest.spot_check(self.clips, self.name, "e", "suv", [""], False)
        with self.assertRaises(ValueError):
            suggest.spot_check(self.clips, self.name, "e", "..", ["x.png"], False)
