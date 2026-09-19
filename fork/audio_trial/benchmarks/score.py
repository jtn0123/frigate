"""Reference-based WER/CER scoring and capacity estimates, never confidence scores."""

import argparse
import json
import unicodedata
from collections.abc import Sequence
from pathlib import Path
from typing import Any


def normalize(text: str) -> str:
    """Normalize Unicode, case and punctuation; retain actual spoken words."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(
        "".join(
            " " if unicodedata.category(char)[0] in "PZ" else char
            for char in text
            if unicodedata.category(char)[0] != "M"
        ).split()
    )


def distance(reference: Sequence[object], candidate: Sequence[object]) -> int:
    """Compute Levenshtein edit count using bounded row storage."""
    previous = list(range(len(candidate) + 1))
    for i, left in enumerate(reference, 1):
        row = [i]
        for j, right in enumerate(candidate, 1):
            row.append(
                min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right))
            )
        previous = row
    return previous[-1]


def summarize(manifest: dict[str, Any], results: dict[str, Any]) -> dict[str, Any]:
    """Aggregate edit counts over reference lengths, not unweighted clip averages."""
    references = {clip["id"]: clip for clip in manifest["clips"]}
    groups: dict[str, dict[str, Any]] = {}
    for row in results["clips"]:
        source = references[row["id"]]
        key = f"{source['language']}/{row.get('variant', 'clean')}"
        group = groups.setdefault(
            key,
            {
                "clips": 0,
                "word_edits": 0,
                "words": 0,
                "character_edits": 0,
                "characters": 0,
                "translation_word_edits": 0,
                "translation_words": 0,
                "seconds": 0,
                "audio_seconds": 0,
            },
        )
        expected = normalize(source["reference"])
        actual = normalize(row["transcribe"]["text"])
        translated = normalize(row["translate"]["text"])
        english = normalize(source["english_reference"])
        group["clips"] += 1
        group["word_edits"] += distance(expected.split(), actual.split())
        group["words"] += len(expected.split())
        group["character_edits"] += distance(
            expected.replace(" ", ""), actual.replace(" ", "")
        )
        group["characters"] += len(expected.replace(" ", ""))
        group["translation_word_edits"] += distance(english.split(), translated.split())
        group["translation_words"] += len(english.split())
        group["seconds"] += row["transcribe"]["seconds"] + row["translate"]["seconds"]
        group["audio_seconds"] += row["audio_seconds"]
    for group in groups.values():
        group["wer_percent"] = 100 * group["word_edits"] / max(1, group["words"])
        group["cer_percent"] = (
            100 * group["character_edits"] / max(1, group["characters"])
        )
        group["translation_reference_edit_percent"] = (
            100 * group["translation_word_edits"] / max(1, group["translation_words"])
        )
        group["real_time_factor"] = group["seconds"] / max(
            0.001, group["audio_seconds"]
        )
    return {
        "model": results["model"],
        "groups": groups,
        "translation_caveat": "English reference edit rate penalizes valid paraphrases; it is not semantic translation accuracy",
        "peak_rss_mib": results.get("peak_rss_mib", results.get("peak_rss_mb")),
        "load_seconds": results["load_seconds"],
    }


def main() -> None:
    """Print a reproducible JSON report from saved public benchmark predictions."""
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("results", type=Path, nargs="+")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    print(
        json.dumps(
            [
                summarize(manifest, json.loads(path.read_text()))
                for path in args.results
            ],
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
