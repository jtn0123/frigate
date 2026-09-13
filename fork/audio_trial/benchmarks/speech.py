"""Benchmark referenced speech on the deployment CPU without publishing events."""

import argparse
import hashlib
import json
import os
import resource
import threading
import time
import urllib.request
from pathlib import Path

import ctranslate2  # noqa: F401
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio


def guard(args, samples, stop, ready, active):
    """Stop a benchmark when measured camera health becomes unsafe."""
    failures = 0
    healthy = 0
    while not stop.is_set():
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:5000/api/stats", timeout=3
            ) as response:
                stats = json.load(response)
            row = {
                "time": time.time(),
                "detectors": stats["detectors"],
                "skipped": {
                    k: v.get("skipped_fps") for k, v in stats["cameras"].items()
                },
                "gpu": stats.get("gpu_usages", {}),
            }
            busy = any(
                v.get("inference_speed", 100) > 30 for v in row["detectors"].values()
            ) or any(v is None or v > 0.5 for v in row["skipped"].values())
            available = next(
                line
                for line in Path("/proc/meminfo").read_text().splitlines()
                if line.startswith("MemAvailable:")
            )
            row["available_kib"] = int(available.split()[1])
            busy = busy or row["available_kib"] < 512 * 1024
            samples.append(row)
            (args.output / f"{args.model}-health.json").write_text(json.dumps(samples))
            failures = failures + 1 if busy else 0
            healthy = 0 if busy else healthy + 1
            if healthy >= 5:
                ready.set()
        except (OSError, ValueError, KeyError, TypeError, StopIteration):
            failures += 1
        if failures >= 3 and active.is_set():
            (args.output / f"{args.model}-aborted.txt").write_text(
                "Camera health or memory guard stopped benchmark"
            )
            os._exit(75)
        stop.wait(3)


def main():
    """Run offline clean/noisy trials, aborting sustained camera pressure."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--weights", required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    samples = []
    stop = threading.Event()
    ready = threading.Event()
    active = threading.Event()

    monitor = threading.Thread(
        target=guard, args=(args, samples, stop, ready, active), daemon=True
    )
    monitor.start()
    if not ready.wait(timeout=300):
        stop.set()
        raise TimeoutError("No healthy camera window within five minutes")
    active.set()
    manifest = json.loads((args.root / "manifest.json").read_text())
    started = time.monotonic()
    model = WhisperModel(
        args.weights,
        device="cpu",
        compute_type="int8",
        cpu_threads=2,
        local_files_only=True,
    )
    result = {
        "model": args.model,
        "threads": 2,
        "load_seconds": time.monotonic() - started,
        "clips": [],
        "dataset": manifest["dataset"],
        "revision": manifest["revision"],
    }
    output_file = args.output / f"{args.model}.json"
    if output_file.exists():
        result["clips"] = json.loads(output_file.read_text())["clips"]
    completed = {(row["id"], row["variant"]) for row in result["clips"]}
    try:
        for clip in manifest["clips"]:
            path = args.root / clip["file"]
            if hashlib.sha256(path.read_bytes()).hexdigest() != clip["sha256"]:
                raise ValueError("Corpus hash mismatch")
            original = decode_audio(str(path), sampling_rate=16000)
            # Controlled noise isolates robustness, not a claim of real street acoustics.
            noise = (
                np.random.default_rng(912)
                .normal(size=original.shape)
                .astype(np.float32)
            )
            noise *= np.sqrt(np.mean(original**2) / (10 * np.mean(noise**2)))
            for variant, audio in (
                ("clean", original),
                ("white_noise_10db", original + noise),
            ):
                if (clip["id"], variant) in completed:
                    continue
                row = {
                    "id": clip["id"],
                    "language": clip["language"],
                    "variant": variant,
                    "audio_seconds": len(audio) / 16000,
                    "reference": clip["reference"],
                    "english_reference": clip["english_reference"],
                }
                for task in ("transcribe", "translate"):
                    start = time.monotonic()
                    segments, info = model.transcribe(
                        audio,
                        language=None,
                        task=task,
                        beam_size=5,
                        vad_filter=True,
                        condition_on_previous_text=False,
                    )
                    row[task] = {
                        "text": " ".join(s.text.strip() for s in segments),
                        "seconds": time.monotonic() - start,
                        "language": info.language,
                    }
                result["clips"].append(row)
                result["peak_rss_mib"] = (
                    resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
                )
                (args.output / f"{args.model}.json").write_text(
                    json.dumps(result, ensure_ascii=False, indent=2)
                )
                print(args.model, clip["id"], variant, flush=True)
    finally:
        stop.set()
        monitor.join(timeout=4)


if __name__ == "__main__":
    main()
