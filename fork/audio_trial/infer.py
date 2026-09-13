"""CPU-only inference in a disposable process to release model memory reliably."""

import argparse
import json
import os
import time
from pathlib import Path

import ctranslate2  # noqa: F401  # Load before ONNX Runtime.
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps
from model_cache import resolve_model
from telemetry import Stage


def classify(path: str) -> list[dict]:
    """Score short windows against sound descriptions, retaining raw similarities."""
    import torch
    from transformers import ClapModel, ClapProcessor

    torch.set_num_threads(2)
    model_path = resolve_model("clap")
    with Stage("clap", loading=True):
        processor = ClapProcessor.from_pretrained(model_path, local_files_only=True)
        model = ClapModel.from_pretrained(model_path, local_files_only=True).eval()
    labels = json.loads(Path("labels.json").read_text())
    prompts = ["The sound of " + name.replace("_", " ") + "." for name in labels]
    audio = decode_audio(path, sampling_rate=48000)
    with torch.inference_mode(), Stage("clap"):
        text = model.get_text_features(
            **processor(text=prompts, return_tensors="pt", padding=True)
        )
        text /= text.norm(dim=-1, keepdim=True)
        scores = []
        for start in range(0, len(audio), 240000):
            window = audio[start : start + 240000]
            window = np.pad(window, (0, max(0, 240000 - len(window))))
            features = model.get_audio_features(
                **processor(audios=window, sampling_rate=48000, return_tensors="pt")
            )
            features /= features.norm(dim=-1, keepdim=True)
            scores.append((features @ text.T)[0].numpy())
    values = np.max(scores, axis=0)
    return [
        {"label": labels[i], "similarity": float(values[i])}
        for i in np.argsort(-values)[:3]
    ]


class Checkpoint:
    """Persist completed stages so retries do not repeat successful inference."""

    def __init__(self, result: dict, path: str | None):
        self.result = result
        self.path = Path(path) if path else None
        if self.path and self.path.exists():
            previous = json.loads(self.path.read_text())
            if previous.get("model") != result["model"] or not isinstance(
                previous.get("stages"), dict
            ):
                raise ValueError("Invalid inference checkpoint")
            result.update(previous)
            result.pop("interrupted", None)

    def save(self):
        """Atomically replace the durable output after each stage transition."""
        if self.path:
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.result, ensure_ascii=False))
            temporary.replace(self.path)

    def run(self, name, operation):
        """Retry a failed stage once, or reuse a completed persisted output."""
        result = self.result
        completed = {
            "transcription": (result["transcript"], result["language"]),
            "translation": result["translation"],
            "sounds": result["sounds"],
        }
        if (
            name in completed
            and result["stages"].get(name, {}).get("status") == "complete"
        ):
            return completed[name]
        for attempt in range(2):
            result["stages"][name] = {"status": "running", "attempts": attempt + 1}
            self.save()
            try:
                value = operation()
            except (OSError, RuntimeError, ValueError) as error:
                result["stages"][name] = {
                    "status": "failed",
                    "error": type(error).__name__,
                    "attempts": attempt + 1,
                }
            else:
                result["stages"][name] = {"status": "complete", "attempts": attempt + 1}
                return value
        self.save()
        return None


def load_whisper(size):
    """Load only the verified local CPU model with the production thread limit."""
    with Stage(size, loading=True):
        return WhisperModel(
            resolve_model(size),
            device="cpu",
            compute_type="int8",
            cpu_threads=2,
            download_root="/models/whisper",
            local_files_only=True,
        )


def whisper_text(model, audio, size, language=None, translate=False):
    """Run one speech stage while retaining the detected language."""
    options = {
        "language": language,
        "beam_size": 5,
        "vad_filter": True,
        "condition_on_previous_text": False,
    }
    if translate:
        options["task"] = "translate"
    with Stage(size):
        segments, info = model.transcribe(audio, **options)
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return text if translate else (text, info.language)


def analyze_speech(audio, size, checkpoint):
    """Preserve transcription before optional translation begins."""
    model = checkpoint.run("load", lambda: load_whisper(size))
    if model is None:
        return
    result = checkpoint.result
    speech = checkpoint.run("transcription", lambda: whisper_text(model, audio, size))
    if speech is None:
        return
    result["transcript"], result["language"] = speech
    result["status"] = "machine transcript; unverified"
    checkpoint.save()
    if result["language"] == "en":
        result["translation"] = result["transcript"]
    elif result["transcript"]:
        result["translation"] = (
            checkpoint.run(
                "translation",
                lambda: whisper_text(model, audio, size, result["language"], True),
            )
            or ""
        )
    checkpoint.save()


def analyze(path: str, size: str, checkpoint: str | None = None) -> dict:
    """Filter nonspeech, transcribe speech, and translate non-English speech."""
    started = time.monotonic()
    audio = decode_audio(path, sampling_rate=16000)
    if not len(audio) or len(audio) > 35 * 16000:
        raise ValueError("Audio must be nonempty and at most 35 seconds")
    with Stage("vad"):
        spans = get_speech_timestamps(audio, VadOptions())
    speech_seconds = sum(span["end"] - span["start"] for span in spans) / 16000
    result = {
        "model": size,
        "speech_seconds": speech_seconds,
        "transcript": "",
        "translation": "",
        "language": None,
        "sounds": [],
        "status": "no clear speech",
        "sound_scores_are_probabilities": False,
        "stages": {},
    }
    progress = Checkpoint(result, checkpoint)
    if speech_seconds >= 0.4:
        analyze_speech(audio, size, progress)
    if size == "medium":
        result["sounds"] = progress.run("sounds", lambda: classify(path)) or []
    if any(stage["status"] == "failed" for stage in result["stages"].values()):
        result["status"] = "partial analysis; unverified"
    result["seconds"] = time.monotonic() - started
    progress.save()
    return result


def job_key_argument(value: str) -> int:
    """Accept only the fixed-width hexadecimal identifier created by the worker."""
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise argparse.ArgumentTypeError("Job key must contain 64 hexadecimal digits")
    return int(value, 16)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", choices=["medium", "large-v3"], default="medium")
    parser.add_argument("--job-key", type=job_key_argument)
    args = parser.parse_args()
    checkpoint = None
    if args.job_key is not None:
        filename = {
            "medium": "medium.checkpoint.json",
            "large-v3": "large.checkpoint.json",
        }[args.model]
        checkpoint = str(
            Path(os.environ.get("STATE_DIR", "/state"))
            / "checkpoints"
            / f"{args.job_key:064x}"
            / filename
        )
    print(json.dumps(analyze(args.audio, args.model, checkpoint), ensure_ascii=False))
