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
from telemetry import Stage


def classify(path: str) -> list[dict]:
    """Score short windows against sound descriptions, retaining raw similarities."""
    import torch
    from transformers import ClapModel, ClapProcessor

    torch.set_num_threads(2)
    model_path = os.environ["CLAP_MODEL"]
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


def analyze(path: str, size: str) -> dict:
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
    if speech_seconds >= 0.4:
        with Stage(size, loading=True):
            model = WhisperModel(
                size,
                device="cpu",
                compute_type="int8",
                cpu_threads=2,
                download_root="/models/whisper",
                local_files_only=True,
            )
        with Stage(size):
            segments, info = model.transcribe(
                audio,
                language=None,
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            result["transcript"] = " ".join(s.text.strip() for s in segments).strip()
            result["language"] = info.language
            if info.language != "en" and result["transcript"]:
                translated, _ = model.transcribe(
                    audio,
                    language=info.language,
                    task="translate",
                    beam_size=5,
                    vad_filter=True,
                    condition_on_previous_text=False,
                )
                result["translation"] = " ".join(s.text.strip() for s in translated)
            elif info.language == "en":
                result["translation"] = result["transcript"]
            result["status"] = "machine transcript; unverified"
        del model
    if size == "medium":
        result["sounds"] = classify(path)
    result["seconds"] = time.monotonic() - started
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", choices=["medium", "large-v3"], default="medium")
    args = parser.parse_args()
    print(json.dumps(analyze(args.audio, args.model), ensure_ascii=False))
