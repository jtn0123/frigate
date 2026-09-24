"""Exercise abstention, provenance, human-label boundaries and read-only access."""

import copy
import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from vehicle_label_trial import (
    VALUES,
    accepted_choice,
    check_lab,
    choice_clues,
    evaluate,
    fingerprint,
    load_rows,
    local_clues,
    main,
    open_read_only,
    prepare_snapshot,
    saved_clues,
)


def choice(winner, values):
    return {
        "type": "choice",
        "choice": winner,
        "probabilities": {v: float(v == winner) for v in values},
        "confidence": 1,
    }


def answers(scope="subject", vehicle_type="van", color="white", carrier="unknown"):
    result = {"subject_scope": choice(scope, {"subject", "scene", "ambiguous"})}
    for field, value in zip(VALUES, (vehicle_type, color, carrier)):
        result[field] = choice(value, VALUES[field] | {"unknown"})
    return result


def event(description="A white van is parked."):
    return {
        "id": "one",
        "camera": "yard",
        "label": "car",
        "data": {"description": description, "lab_import": True},
        "reviews": [],
    }


def response(row, fields=None):
    return {
        "event_id": row["id"],
        "camera": row["camera"],
        "description_sha256": hashlib.sha256(
            row["data"]["description"].encode()
        ).hexdigest(),
        "contract_hash": "test-contract",
        "status": "received",
        "answers": fields or answers(),
    }


class VehicleTrialTest(unittest.TestCase):
    def test_cli_replay_export_and_result_contract_requirement(self):
        with tempfile.TemporaryDirectory() as temporary:
            snapshot = Path(temporary) / "snapshot.json"
            snapshot.write_text(json.dumps([event()]))
            output = io.StringIO()
            with patch("sys.argv", ["trial", "--snapshot", str(snapshot)]):
                with redirect_stdout(output):
                    main()
            report = json.loads(output.getvalue())
            self.assertFalse(report["comparison_available"])
            self.assertIsNone(report["missing_source_approved_vehicle_reviews"])
            self.assertNotIn("A white van", output.getvalue())
            output = io.StringIO()
            with patch(
                "sys.argv", ["trial", "--snapshot", str(snapshot), "--export-snapshot"]
            ):
                with redirect_stdout(output):
                    main()
            self.assertEqual(json.loads(output.getvalue()), [event()])
            with patch("sys.argv", ["trial", "--jev-results", "missing.json"]):
                with (
                    redirect_stderr(io.StringIO()),
                    self.assertRaises(SystemExit) as error,
                ):
                    main()
            self.assertEqual(error.exception.code, 2)

    def test_database_mode_requires_all_lab_markers(self):
        with patch.dict("os.environ", {"FRIGATE_FINDINGS_LAB": "0"}):
            with self.assertRaises(ValueError):
                check_lab()
        with patch.dict("os.environ", {"FRIGATE_FINDINGS_LAB": "1"}):
            with patch.object(Path, "read_text", return_value="wrong"):
                with self.assertRaises(ValueError):
                    check_lab()
            with patch.object(Path, "read_text", return_value="findings-lab-v1\n"):
                with patch.object(Path, "is_file", return_value=False):
                    with self.assertRaises(ValueError):
                        check_lab()
                with patch.object(Path, "is_file", return_value=True):
                    check_lab()

    def test_snapshot_requires_crop_and_label_binding_and_filters_non_lab_events(self):
        row = event()
        row["reviews"] = [
            {
                "event_id": row["id"],
                "camera": row["camera"],
                "decision": "wrong",
                "label": "car",
                "metadata": {"crop_sha256": "a" * 64},
                "attributes": {"vehicle_type": "van"},
            }
        ]
        self.assertEqual(prepare_snapshot([row])[0]["reviews"][0]["attributes"], {})
        row["reviews"][0]["attribute_bindings"] = {
            "vehicle_type": {"crop_sha256": "a" * 64, "label": "car"}
        }
        self.assertEqual(
            prepare_snapshot([row])[0]["reviews"][0]["attributes"],
            {"vehicle_type": "van"},
        )
        row["data"]["lab_import"] = False
        self.assertEqual(prepare_snapshot([row]), [])

    def test_request_template_matches_shared_field_choices(self):
        template = json.loads(
            (
                Path(__file__).parents[1]
                / "experiments/vehicle-labels/jev-request.json"
            ).read_text()
        )
        self.assertEqual(template["model"], "typesafe/jev-1.13")
        for field, values in VALUES.items():
            self.assertEqual(
                set(template["questions"][field]["criteria"]), values | {"unknown"}
            )

    def test_generic_second_vehicle_cannot_lend_its_attributes(self):
        for text in (
            "A red car passes a truck with UPS branding.",
            "A white delivery truck pulls up beside a red sedan.",
            "A red sedan is beside a white sedan.",
        ):
            with self.subTest(text=text):
                self.assertTrue(
                    all(p["value"] == "unknown" for p in local_clues(text).values())
                )

    def test_duplicate_reviews_have_one_event_denominator_and_conflicts_abstain(self):
        row = event()
        review = {
            "decision": "wrong",
            "label": "car",
            "attributes": {"vehicle_type": "van"},
        }
        row["reviews"] = [review, copy.deepcopy(review)]
        report = evaluate([row], [response(row)], "test-contract")
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["human_known"], 1)
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["matched"], 1)
        row["reviews"][1]["attributes"]["vehicle_type"] = "suv"
        report = evaluate([row], [response(row)], "test-contract")
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["human_known"], 0)
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["human_contested"], 1)

    def test_malformed_duplicate_and_orphan_responses_are_counted_and_rejected(self):
        row = event()
        valid = response(row)
        orphan = {**valid, "event_id": "gone"}
        report = evaluate([row], [None, {}, valid, valid, orphan], "test-contract")
        self.assertEqual(report["rejected_live_results"], 5)
        self.assertEqual(report["live_jev_responses"], 0)

    def test_unrequested_is_not_abstention_and_whitespace_is_missing(self):
        report = evaluate([event("   ")])
        self.assertEqual(report["described"], 0)
        self.assertEqual(report["lanes"], {"needs_better_description": 1})
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["not_evaluated"], 1)
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["abstained"], 0)

    def test_explicit_type_color_without_inventing_carrier(self):
        result = local_clues("A white van is parked.")
        self.assertEqual(result["vehicle_type"]["value"], "van")
        self.assertEqual(result["vehicle_color"]["value"], "white")
        self.assertEqual(result["vehicle_carrier"]["value"], "unknown")
        self.assertIsNone(result["vehicle_type"]["score"])

    def test_none_requires_explicit_absence(self):
        self.assertEqual(
            local_clues("A van has no visible carrier branding.")["vehicle_carrier"][
                "value"
            ],
            "none",
        )
        self.assertEqual(
            local_clues("A plain white van is parked.")["vehicle_carrier"]["value"],
            "unknown",
        )

    def test_multisubject_negation_and_speculation_abstain(self):
        for text in (
            "A car is parked while another UPS van passes.",
            "No car is visible. A black UPS delivery truck is parked.",
            "This could be a van.",
            "A black pickup is parked in front of a white SUV.",
        ):
            with self.subTest(text=text):
                self.assertTrue(
                    all(
                        item["value"] == "unknown"
                        for item in local_clues(text).values()
                    )
                )

    def test_bus_and_motorcycle_are_not_forced_to_car(self):
        for name in ("bus", "motorcycle"):
            self.assertEqual(
                local_clues(f"A red {name} is visible.")["vehicle_type"]["value"], name
            )

    def test_person_logo_is_not_vehicle_branding(self):
        self.assertEqual(
            local_clues("A person with a UPS logo on their shirt stands by a van.")[
                "vehicle_carrier"
            ]["value"],
            "unknown",
        )

    def test_scope_gates_otherwise_certain_fields(self):
        self.assertTrue(
            all(
                p["value"] == "unknown"
                for p in choice_clues(answers(scope="scene")).values()
            )
        )
        fields = answers()
        fields["subject_scope"]["probabilities"] = {
            "subject": 0.75,
            "scene": 0.06,
            "ambiguous": 0.19,
        }
        self.assertTrue(
            all(p["value"] == "unknown" for p in choice_clues(fields).values())
        )

    def test_invalid_distribution_abstains(self):
        for probabilities in (
            {"a": 1},
            {"a": True, "b": 0},
            {"a": float("nan"), "b": 0},
            {"a": 0.5, "b": 0.5},
            {"a": 1, "b": 1},
        ):
            with self.subTest(probabilities=probabilities):
                self.assertIsNone(
                    accepted_choice(
                        {
                            "type": "choice",
                            "choice": "a",
                            "probabilities": probabilities,
                        },
                        {"a", "b"},
                    )
                )

    def test_stale_saved_jev_abstains(self):
        row = event()
        row["data"]["fork_description_analysis"] = {
            "status": "complete",
            "refinements_contract": 1,
            "fingerprint": fingerprint("Old text", "car"),
            "refinements": {
                "vehicle_type": {"source": "jev_text", "value": "van", "score": 0.99}
            },
        }
        self.assertEqual(saved_clues(row)["vehicle_type"]["value"], "unknown")
        row["data"]["fork_description_analysis"]["fingerprint"] = fingerprint(
            row["data"]["description"], "car"
        )
        self.assertEqual(saved_clues(row)["vehicle_type"]["value"], "van")

    def test_live_results_are_bound_to_description_and_contract(self):
        row = event()
        saved = response(row)
        for key in ("description_sha256", "contract_hash"):
            wrong = {**saved, key: "wrong"}
            report = evaluate([row], [wrong], "test-contract")
            self.assertEqual(report["rejected_live_results"], 1)
            self.assertEqual(report["fields"]["vehicle_type"]["jev"]["offered"], 0)

    def test_agreement_does_not_override_human_or_become_truth(self):
        row = event()
        row["reviews"] = [
            {
                "decision": "correct",
                "label": "car",
                "attributes": {"vehicle_type": "suv", "vehicle_color": "unsure"},
            }
        ]
        before = copy.deepcopy(row)
        report = evaluate([row], [response(row)], "test-contract")
        self.assertEqual(row, before)
        for source in ("local", "jev"):
            self.assertEqual(report["fields"]["vehicle_type"][source]["mismatched"], 1)
            self.assertEqual(
                report["fields"]["vehicle_color"][source]["human_known"], 0
            )

    def test_no_review_or_unsure_never_counts_as_correct(self):
        row = event()
        row["reviews"] = [
            {
                "decision": "unsure",
                "label": "car",
                "attributes": {"vehicle_type": "van"},
            }
        ]
        report = evaluate([row], [response(row)], "test-contract")
        self.assertFalse(report["comparison_available"])
        self.assertEqual(report["fields"]["vehicle_type"]["jev"]["matched"], 0)

    def test_database_is_read_only_and_attributes_require_crop_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events, reviews = root / "events.sqlite", root / "reviews.sqlite"
            with closing(sqlite3.connect(events)) as conn, conn:
                conn.execute(
                    "CREATE TABLE event (id TEXT,camera TEXT,label TEXT,data TEXT)"
                )
                conn.execute(
                    "INSERT INTO event VALUES ('one','yard','car',?)",
                    (json.dumps(event()["data"]),),
                )
            with closing(sqlite3.connect(reviews)) as conn, conn:
                conn.execute(
                    "CREATE TABLE reviews (id TEXT,event_id TEXT,camera TEXT,decision TEXT,label TEXT,metadata TEXT,image BLOB)"
                )
                conn.execute(
                    "INSERT INTO reviews VALUES ('r1','one','yard','correct','car',?,?)",
                    (json.dumps({"crop_sha256": "original"}), b"private image"),
                )
            original = reviews.read_bytes()
            rows, missing = load_rows(events, reviews)
            self.assertEqual(missing, 0)
            self.assertEqual(rows[0]["reviews"][0]["attributes"], {})
            self.assertEqual(reviews.read_bytes(), original)
            with closing(sqlite3.connect(reviews)) as conn, conn:
                conn.execute(
                    "CREATE TABLE attributes (id TEXT,name TEXT,crop_sha256 TEXT,label TEXT,value TEXT)"
                )
                conn.execute(
                    "INSERT INTO attributes VALUES ('r1','vehicle_type','old','car','van')"
                )
            rows, _ = load_rows(events, reviews)
            self.assertEqual(rows[0]["reviews"][0]["attributes"], {})
            with closing(sqlite3.connect(reviews)) as conn, conn:
                conn.execute("UPDATE reviews SET metadata='{}'")
                conn.execute("UPDATE attributes SET crop_sha256=NULL")
            rows, _ = load_rows(events, reviews)
            self.assertEqual(rows[0]["reviews"][0]["attributes"], {})
            conn = open_read_only(reviews)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    conn.execute("DELETE FROM reviews")
            finally:
                conn.close()
            with self.assertRaises(sqlite3.OperationalError):
                open_read_only(root / "missing.sqlite")
            self.assertFalse((root / "missing.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
