"""CPU-only inference in a disposable process to release model memory reliably."""

import argparse
import json
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


def analyze(path: str, size: str, checkpoint: str | None = None) -> dict:
    """Filter nonspeech, transcribe speech, and translate non-English speech."""
    started = time.monotonic()
    audio = decode_audio(path, sampling_rate=16000)
    if not len(audio) or len(audio) > 35 * 16000:
        raise ValueError("Audio must be nonempty and at most 35 seconds")
    with Stage("vad"):
        spans = get_speech_timestamps(audio, VadOptions())
    speech_seconds = sum(s["end"] - s["start"] for s in spans) / 16000
    result = {
        "model": size,
        "speech_seconds": speech_seconds,
        "transcript": "",
        "translation": "",
        "language": None,
        "sounds": [],
        "status": "no clear speech",
        "sound_scores_are_probabilities": False,
    }
    result["stages"] = {}

    if checkpoint and Path(checkpoint).exists():
        previous = json.loads(Path(checkpoint).read_text())
        if previous.get("model") != size or not isinstance(
            previous.get("stages"), dict
        ):
            raise ValueError("Invalid inference checkpoint")
        result.update(previous)
        result.pop("interrupted", None)

    def save():
        if checkpoint:
            target = Path(checkpoint)
            temporary = target.with_suffix(".tmp")
            temporary.write_text(json.dumps(result, ensure_ascii=False))
            temporary.replace(target)

    def run_stage(name, operation):
        # Runtime allocation must reload, but completed outputs survive a restart.
        if result["stages"].get(name, {}).get("status") == "complete":
            if name == "transcription":
                return result["transcript"], result["language"]
            if name == "translation":
                return result["translation"]
            if name == "sounds":
                return result["sounds"]
        # Retry only the failed stage, not completed speech or sound analysis.
        for attempt in range(2):
            result["stages"][name] = {"status": "running", "attempts": attempt + 1}
            save()
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
        save()
        return None

    if speech_seconds >= 0.4:

        def load_model():
            with Stage(size, loading=True):
                return WhisperModel(
                    resolve_model(size),
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=2,
                    download_root="/models/whisper",
                    local_files_only=True,
                )

        model = run_stage("load", load_model)
        if model is not None:

            def transcribe():
                with Stage(size):
                    segments, info = model.transcribe(
                        audio,
                        language=None,
                        beam_size=5,
                        vad_filter=True,
                        condition_on_previous_text=False,
                    )
                    return " ".join(
                        s.text.strip() for s in segments
                    ).strip(), info.language

            speech = run_stage("transcription", transcribe)
            if speech is not None:
                result["transcript"], result["language"] = speech
                result["status"] = "machine transcript; unverified"
                save()
                if result["language"] == "en":
                    result["translation"] = result["transcript"]
                elif result["transcript"]:

                    def translate():
                        with Stage(size):
                            segments, _ = model.transcribe(
                                audio,
                                language=result["language"],
                                task="translate",
                                beam_size=5,
                                vad_filter=True,
                                condition_on_previous_text=False,
                            )
                            return " ".join(s.text.strip() for s in segments)

                    result["translation"] = run_stage("translation", translate) or ""
            save()
            del model
    if size == "medium":
        result["sounds"] = run_stage("sounds", lambda: classify(path)) or []
    if any(stage["status"] == "failed" for stage in result["stages"].values()):
        result["status"] = "partial analysis; unverified"
    result["seconds"] = time.monotonic() - started
    save()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", choices=["medium", "large-v3"], default="medium")
    parser.add_argument("--checkpoint")
    args = parser.parse_args()
    print(
        json.dumps(analyze(args.audio, args.model, args.checkpoint), ensure_ascii=False)
    )
