"""Read-only vehicle description trial; drafts never become training labels."""

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

VEHICLES = {"car", "truck", "bus", "motorcycle"}
VALUES = {
    "vehicle_type": {"car", "van", "suv", "pickup", "box_truck", "bus", "motorcycle"},
    "vehicle_color": {
        "white",
        "black",
        "gray_silver",
        "red",
        "blue",
        "green",
        "brown_tan",
        "yellow",
        "orange",
        "other",
    },
    "vehicle_carrier": {"ups", "fedex", "usps", "amazon", "dhl", "other", "none"},
}
TYPE_PATTERN = r"\b(box truck|pickup(?: truck)?|suv|crossover|minivan|van|sedan|car|bus|motorcycle)\b"
TYPE_MAP = {
    "box truck": "box_truck",
    "pickup truck": "pickup",
    "crossover": "suv",
    "minivan": "van",
    "sedan": "car",
}
COLOR_PATTERN = (
    r"\b(white|black|gray|grey|silver|red|blue|green|brown|tan|yellow|orange)\b"
)
COLOR_MAP = {
    "gray": "gray_silver",
    "grey": "gray_silver",
    "silver": "gray_silver",
    "brown": "brown_tan",
    "tan": "brown_tan",
}
FIELDS = tuple(VALUES)


def fingerprint(description: str, label: str) -> str:
    """Match the existing lab's version-2 description analysis fingerprint."""
    value = json.dumps(["typesafe/jev-1.13", 2, description, label], ensure_ascii=True)
    return hashlib.sha256(value.encode()).hexdigest()


def clue(
    value: str, source: str, reason: str, evidence: str = "", score: float | None = None
) -> dict[str, Any]:
    """Represent a draft or an explicit abstention with its provenance."""
    return {
        "value": value,
        "source": source,
        "reason": reason,
        "evidence": evidence,
        "score": score,
    }


def unknowns(source: str, reason: str) -> dict[str, Any]:
    """Create independent unknown field records."""
    return {field: clue("unknown", source, reason) for field in FIELDS}


def local_clues(description: str) -> dict[str, Any]:
    """Extract a deliberately narrow lexical baseline, not a vision judgment."""
    result = unknowns("local_text", "not_explicit")
    if not description.strip():
        return unknowns("local_text", "missing_description")
    text = description.lower()
    matches = list(re.finditer(TYPE_PATTERN, text))
    types = {TYPE_MAP.get(m.group(1), m.group(1)) for m in matches}
    uncertain = re.search(
        r"\b(maybe|might|possibly|probably|could|seems|appears)\b", text
    )
    negated = re.search(
        r"\b(?:no|not a|not the)\s+(?:\w+\s+){0,2}(?:car|van|truck|suv|vehicle|bus|motorcycle)\b",
        text,
    )
    multiple = re.search(
        r"\b(?:two|three|several|multiple|another|other)\s+(?:\w+\s+){0,2}(?:cars?|vans?|trucks?|suvs?|vehicles?|buses|motorcycles?)\b",
        text,
    )
    # Include generic nouns when counting subjects, even though they cannot
    # identify a vehicle subtype. Otherwise a nearby truck can lend its logo.
    subjects = re.findall(
        r"\b(?:a|an|another)\s+(?:\w+\s+){0,3}"
        r"(?:box truck|pickup truck|suv|crossover|minivan|van|sedan|car|bus|motorcycle|truck|vehicle)\b",
        text,
    )
    if uncertain or negated or multiple or len(types) > 1 or len(subjects) > 1:
        return unknowns("local_text", "ambiguous_subject")
    if len(types) == 1:
        result["vehicle_type"] = clue(
            next(iter(types)), "local_text", "explicit_text", matches[0].group()
        )
    colors = set()
    evidence = ""
    for match in re.finditer(
        COLOR_PATTERN
        + r"\s+(?:(?:small|large|compact|parked|passenger)\s+){0,2}"
        + TYPE_PATTERN,
        text,
    ):
        colors.add(COLOR_MAP.get(match.group(1), match.group(1)))
        evidence = match.group()
    if len(colors) == 1:
        result["vehicle_color"] = clue(
            next(iter(colors)), "local_text", "explicit_text", evidence
        )
    for sentence in re.split(r"[.!?]", text):
        if not re.search(TYPE_PATTERN + r"|\bvehicle\b", sentence):
            continue
        if re.search(r"\b(driver|person|uniform|package|shirt)\b", sentence):
            continue
        carriers = re.findall(r"\b(ups|fedex|usps|amazon|dhl)\b", sentence)
        branding = re.search(r"\b(logo|branding|branded|markings)\b", sentence)
        if (
            len(set(carriers)) == 1
            and branding
            and not re.search(r"\b(no|not|without)\b", sentence)
        ):
            result["vehicle_carrier"] = clue(
                carriers[0], "local_text", "explicit_text", sentence.strip()
            )
        elif re.search(
            r"\bno (?:visible )?(?:carrier )?(?:branding|logos?|markings)\b", sentence
        ):
            result["vehicle_carrier"] = clue(
                "none", "local_text", "explicit_absence", sentence.strip()
            )
    return result


def accepted_choice(answer: Any, allowed: set[str]) -> tuple[str, float] | None:
    """Validate a complete distribution and apply provisional .9/.2 gates."""
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return None
    probabilities = answer.get("probabilities")
    if not isinstance(probabilities, dict) or set(probabilities) != allowed:
        return None
    if any(
        isinstance(v, bool)
        or not isinstance(v, (float, int))
        or not math.isfinite(v)
        or not 0 <= v <= 1
        for v in probabilities.values()
    ):
        return None
    if not 0.98 <= sum(probabilities.values()) <= 1.02:
        return None
    distribution: dict[str, float] = probabilities
    ranked = sorted(distribution, key=distribution.__getitem__, reverse=True)
    winner = ranked[0]
    score = distribution[winner]
    if (
        answer.get("choice") != winner
        or score < 0.9
        or score - probabilities[ranked[1]] < 0.2
    ):
        return None
    return winner, score


def choice_clues(answers: Any) -> dict[str, Any]:
    """Gate field proposals on clear same-subject attribution first."""
    if not isinstance(answers, dict):
        return unknowns("jev_trial", "missing_response")
    scope = accepted_choice(
        answers.get("subject_scope"), {"subject", "scene", "ambiguous"}
    )
    if scope is None or scope[0] != "subject":
        return unknowns("jev_trial", "subject_not_established")
    result = unknowns("jev_trial", "uncertain_or_invalid")
    for field in FIELDS:
        accepted = accepted_choice(answers.get(field), VALUES[field] | {"unknown"})
        if accepted:
            value, score = accepted
            result[field] = clue(
                value,
                "jev_trial",
                "explicit_text" if value != "unknown" else "not_explicit",
                score=score,
            )
    return result


def saved_clues(event: dict[str, Any]) -> dict[str, Any]:
    """Read only current, accepted legacy Jev refinements."""
    data = event.get("data") or {}
    analysis = data.get("fork_description_analysis") or {}
    if (
        not isinstance(analysis, dict)
        or analysis.get("status") != "complete"
        or analysis.get("refinements_contract") != 1
        or analysis.get("fingerprint")
        != fingerprint(data.get("description") or "", event["label"])
    ):
        return unknowns("jev_saved", "missing_or_stale")
    result = unknowns("jev_saved", "not_offered")
    refinements = analysis.get("refinements") or {}
    if not isinstance(refinements, dict):
        return result
    for field in FIELDS:
        item = refinements.get(field)
        if not isinstance(item, dict):
            continue
        score = item.get("score")
        if (
            item.get("source") == "jev_text"
            and item.get("value") in VALUES[field]
            and not isinstance(score, bool)
            and isinstance(score, (int, float))
            and math.isfinite(score)
            and 0.9 <= score <= 1
        ):
            result[field] = clue(
                item["value"], "jev_saved", "legacy_thresholded", score=score
            )
    return result


def evaluate(
    rows: list[dict[str, Any]],
    responses: list[dict[str, Any]] | None = None,
    contract_hash: str | None = None,
    details: bool = False,
) -> dict[str, Any]:
    """Compare suggestions with available human attributes without mutation."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    rejected = 0
    current = {(r["camera"], r["id"]) for r in rows}
    for response in responses or []:
        if not isinstance(response, dict) or not all(
            isinstance(response.get(key), str) for key in ("camera", "event_id")
        ):
            rejected += 1
            continue
        key = (response["camera"], response["event_id"])
        if key not in current:
            rejected += 1
            continue
        groups.setdefault(key, []).append(response)
    external = {}
    for key, group in groups.items():
        if len(group) != 1:
            rejected += len(group)
        else:
            external[key] = group[0]
    report: dict[str, Any] = {
        "events": len(rows),
        "described": 0,
        "human_reviewed_events": 0,
        "live_jev_responses": 0,
        "rejected_live_results": rejected,
        "lanes": {},
        "fields": {},
        "comparison_available": False,
        "limitations": [
            "Text clues are correlated with their source description",
            "Retrospective agreement is not independent held-out accuracy",
            "The .9 probability and .2 margin gates are provisional",
            "Drafts never become training labels or retention decisions",
        ],
    }
    for field in FIELDS:
        report["fields"][field] = {
            source: {
                "offered": 0,
                "abstained": 0,
                "not_evaluated": 0,
                "human_known": 0,
                "matched": 0,
                "mismatched": 0,
                "human_unknown": 0,
                "human_unsupported": 0,
                "human_contested": 0,
                "none_offered": 0,
            }
            for source in ("local", "jev")
        }
    items = []
    for event in rows:
        description = (event.get("data") or {}).get("description") or ""
        has_description = bool(description.strip())
        report["described"] += has_description
        local = local_clues(description)
        # A replay of new responses must never silently fall back to an older
        # question contract. Missing results are distinct from abstentions.
        jev = (
            saved_clues(event)
            if responses is None
            else unknowns("jev_trial", "not_evaluated")
        )
        jev_evaluated = any(
            p["reason"] not in {"missing_or_stale", "not_evaluated"}
            for p in jev.values()
        )
        live_response = external.get((event["camera"], event["id"]))
        if live_response:
            if (
                contract_hash
                and live_response.get("contract_hash") == contract_hash
                and live_response.get("description_sha256")
                == hashlib.sha256(description.encode()).hexdigest()
                and live_response.get("status") == "received"
            ):
                jev = choice_clues(live_response.get("answers"))
                jev_evaluated = True
                report["live_jev_responses"] += 1
            else:
                report["rejected_live_results"] += 1
        reviews = [
            r
            for r in event.get("reviews", [])
            if r.get("decision") in {"correct", "wrong"} and r.get("label") in VEHICLES
        ]
        report["human_reviewed_events"] += bool(reviews)
        conflict = any(
            local[f]["value"] != "unknown"
            and jev[f]["value"] != "unknown"
            and local[f]["value"] != jev[f]["value"]
            for f in FIELDS
        )
        offered = any(p[f]["value"] != "unknown" for p in (local, jev) for f in FIELDS)
        lane = (
            "needs_better_description"
            if not has_description
            else "needs_attention"
            if conflict or not offered
            else "proposal_ready"
        )
        report["lanes"][lane] = report["lanes"].get(lane, 0) + 1
        for field in FIELDS:
            for source, proposals in (("local", local), ("jev", jev)):
                value = proposals[field]["value"]
                count = report["fields"][field][source]
                if source == "jev" and not jev_evaluated:
                    count["not_evaluated"] += 1
                else:
                    count["offered" if value != "unknown" else "abstained"] += 1
                count["none_offered"] += value == "none"
                # Score one event once. Different reviewed crops can belong to
                # different subjects, so contradictory labels are not a vote.
                human = {
                    review.get("attributes", {}).get(field) for review in reviews
                } - {None, "unknown", "unsure"}
                if human - VALUES[field]:
                    count["human_unsupported"] += 1
                elif len(human) > 1:
                    count["human_contested"] += 1
                elif not human:
                    count["human_unknown"] += bool(reviews)
                else:
                    answer = next(iter(human))
                    count["human_known"] += 1
                    if value != "unknown":
                        count["matched" if value == answer else "mismatched"] += 1
                        if source == "jev":
                            report["comparison_available"] = True
        if details:
            items.append(
                {
                    "event_id": event["id"],
                    "camera": event["camera"],
                    "description": description,
                    "local": local,
                    "jev": jev,
                    "lane": lane,
                }
            )
    if details:
        report["items"] = items
    return report


def open_read_only(path: Path) -> sqlite3.Connection:
    """Open an existing database without creating it or changing its schema."""
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("BEGIN")
    return conn


def bound_attribute(review: dict[str, Any], attribute: dict[str, Any]) -> bool:
    """Require a real original-crop digest and the human's current core label."""
    digest = (review.get("metadata") or {}).get("crop_sha256")
    return (
        isinstance(digest, str)
        and re.fullmatch(r"[a-f0-9]{64}", digest) is not None
        and attribute.get("crop_sha256") == digest
        and attribute.get("label") == review.get("label")
        and isinstance(review.get("label"), str)
    )


def prepare_snapshot(snapshot: Any) -> list[dict[str, Any]]:
    """Apply the same import and attribute binding rules to private replays."""
    if not isinstance(snapshot, list):
        raise ValueError("Snapshot must be an event list")
    rows = []
    for source in snapshot:
        if not isinstance(source, dict) or not isinstance(source.get("data"), dict):
            raise ValueError("Invalid snapshot event")
        if source.get("label") not in VEHICLES or not source["data"].get("lab_import"):
            continue
        if not all(isinstance(source.get(key), str) for key in ("camera", "id")):
            raise ValueError("Invalid snapshot event identity")
        row = copy.deepcopy(source)
        row["reviews"] = [
            review
            for review in row.get("reviews", [])
            if isinstance(review, dict)
            and review.get("event_id") == row["id"]
            and review.get("camera") == row["camera"]
        ]
        for review in row.get("reviews", []):
            bindings = review.get("attribute_bindings") or {}
            review["attributes"] = {
                field: value
                for field, value in review.get("attributes", {}).items()
                if field in FIELDS
                and isinstance(bindings.get(field), dict)
                and bound_attribute(review, bindings[field])
            }
        rows.append(row)
    return rows


def load_rows(event_db: Path, review_db: Path) -> tuple[list[dict[str, Any]], int]:
    """Load text and crop-bound review metadata, never image bytes."""
    with (
        closing(open_read_only(event_db)) as events,
        closing(open_read_only(review_db)) as reviews_db,
    ):
        reviews = {}
        for row in reviews_db.execute(
            "SELECT id,event_id,camera,decision,label,metadata FROM reviews WHERE decision IN ('correct','wrong')"
        ):
            review = dict(row)
            review["metadata"] = json.loads(review["metadata"] or "{}")
            review["attributes"] = {}
            review["attribute_bindings"] = {}
            reviews[review["id"]] = review
        tables = {
            row[0]
            for row in reviews_db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if "attributes" in tables:
            for row in reviews_db.execute(
                "SELECT id,name,crop_sha256,label,value FROM attributes"
            ):
                matched_review = reviews.get(row["id"])
                if (
                    matched_review
                    and row["name"] in FIELDS
                    and bound_attribute(matched_review, dict(row))
                ):
                    matched_review["attributes"][row["name"]] = row["value"]
                    matched_review["attribute_bindings"][row["name"]] = {
                        "crop_sha256": row["crop_sha256"],
                        "label": row["label"],
                    }
        rows = []
        for row in events.execute(
            "SELECT id,camera,label,data FROM event WHERE label IN ('car','truck','bus','motorcycle') ORDER BY id"
        ):
            event = dict(row)
            event["data"] = json.loads(event["data"] or "{}")
            if not event["data"].get("lab_import"):
                continue
            event["reviews"] = [
                r
                for r in reviews.values()
                if r["event_id"] == event["id"] and r["camera"] == event["camera"]
            ]
            rows.append(event)
    present = {(r["camera"], r["id"]) for r in rows}
    missing = sum(
        r["label"] in VEHICLES and (r["camera"], r["event_id"]) not in present
        for r in reviews.values()
    )
    return rows, missing


def check_lab() -> None:
    """Restrict database inspection to the explicitly marked sample lab."""
    if (
        os.environ.get("FRIGATE_FINDINGS_LAB") != "1"
        or Path("/config/findings-lab.marker").read_text().strip() != "findings-lab-v1"
        or not Path("/config/findings-sample.json").is_file()
    ):
        raise ValueError("Run database mode only inside the isolated findings lab")


def main() -> None:
    """Print aggregate results or an explicitly requested private detail report."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-db", type=Path, default=Path("/config/frigate.db"))
    parser.add_argument(
        "--reviews-db", type=Path, default=Path("/config/classification-review.sqlite")
    )
    parser.add_argument(
        "--snapshot",
        type=Path,
        help="Replay an exported private JSON snapshot instead of opening databases",
    )
    parser.add_argument("--jev-results", type=Path)
    parser.add_argument(
        "--contract-hash", help="Expected SHA256 of the trial request questions"
    )
    parser.add_argument("--details", action="store_true")
    parser.add_argument(
        "--export-snapshot",
        action="store_true",
        help="Export private text and bound review metadata for offline replay",
    )
    args = parser.parse_args()
    if args.jev_results and not args.contract_hash:
        parser.error("--jev-results requires --contract-hash")
    missing = None
    if args.snapshot:
        rows = prepare_snapshot(json.loads(args.snapshot.read_text()))
    else:
        check_lab()
        rows, missing = load_rows(args.events_db, args.reviews_db)
    if args.export_snapshot:
        print(json.dumps(rows))
        return
    responses = json.loads(args.jev_results.read_text()) if args.jev_results else None
    report = evaluate(rows, responses, args.contract_hash, args.details)
    report["missing_source_approved_vehicle_reviews"] = missing
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
