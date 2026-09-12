"""Bounded extra-camera decode/inference load, with production camera abort gates.

Run in an isolated copy of the production ROCm image. This measures components,
not recording, motion tracking, network reliability, or a full camera rollout.
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort


def stats():
    """Capture existing camera performance without changing Frigate."""
    with urllib.request.urlopen(
        "http://127.0.0.1:5000/api/stats", timeout=3
    ) as response:
        data = json.load(response)
    return {
        "time": time.time(),
        "source_updated": data["service"]["last_updated"],
        "detectors": data["detectors"],
        "gpu": data.get("gpu_usages", {}),
        "skipped": {
            name: item["skipped_fps"] for name, item in data["cameras"].items()
        },
    }


def healthy(sample):
    """Use the same conservative camera limits as the companion worker."""
    return (
        time.time() - sample["source_updated"] < 90
        and all(v["inference_speed"] <= 30 for v in sample["detectors"].values())
        and all(v <= 0.5 for v in sample["skipped"].values())
    )


def main():
    """Test two then four additional 720p15 decode streams with 5 FPS detection."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=90, choices=range(30, 301))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "description": "Synthetic H264 1280x720 15 FPS, VAAPI decode, YOLO 320 every frame at 5 FPS; excludes recording/tracking",
        "samples": [],
        "phases": [],
    }
    stop = threading.Event()
    ready = threading.Event()
    active = threading.Event()

    def save():
        (args.output / "capacity.json").write_text(json.dumps(report, indent=2))

    def monitor():
        good = bad = 0
        while not stop.is_set():
            try:
                sample = stats()
                report["samples"].append(sample)
                good = good + 1 if healthy(sample) else 0
                bad = 0 if healthy(sample) else bad + 1
                if good >= 5:
                    ready.set()
            except (OSError, ValueError, KeyError, TypeError):
                bad += 1
            if bad >= 3 and active.is_set():
                report["aborted"] = "Camera health threshold exceeded"
                save()
                os._exit(75)
            stop.wait(3)

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    if not ready.wait(timeout=300):
        report["aborted"] = "No healthy baseline in five minutes; no workload started"
        save()
        return
    active.set()
    ffmpeg = (
        shutil.which("ffmpeg") or sorted(glob.glob("/usr/lib/ffmpeg/*/bin/ffmpeg"))[-1]
    )
    clip = "/tmp/capacity-source.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=15",
            "-t",
            "10",
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-preset",
            "ultrafast",
            "-y",
            clip,
        ],
        check=True,
        timeout=60,
    )
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    if "MIGraphXExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("ROCm provider is required, refusing CPU fallback")
    model = ort.InferenceSession(
        "/models/yolov9-s-320.onnx",
        sess_options=options,
        providers=["MIGraphXExecutionProvider"],
    )
    report["providers"] = model.get_providers()
    name = model.get_inputs()[0].name
    frame_bytes = 320 * 320 * 3
    try:
        for count in (2, 4):
            phase = {
                "extra_cameras": count,
                "started": time.time(),
                "frames": [0] * count,
                "inference_ms": [],
            }
            report["phases"].append(phase)
            processes = []
            try:
                for _ in range(count):
                    processes.append(
                        subprocess.Popen(
                            [
                                ffmpeg,
                                "-hide_banner",
                                "-loglevel",
                                "error",
                                "-threads",
                                "1",
                                "-hwaccel",
                                "vaapi",
                                "-hwaccel_device",
                                "/dev/dri/renderD128",
                                "-hwaccel_output_format",
                                "vaapi",
                                "-re",
                                "-stream_loop",
                                "-1",
                                "-i",
                                clip,
                                "-an",
                                "-vf",
                                "hwdownload,format=nv12,fps=5,scale=320:320,format=rgb24",
                                "-f",
                                "rawvideo",
                                "pipe:1",
                            ],
                            stdout=subprocess.PIPE,
                        )
                    )
                deadline = time.monotonic() + args.seconds
                while time.monotonic() < deadline:
                    for index, process in enumerate(processes):
                        frame = process.stdout.read(frame_bytes)
                        if len(frame) != frame_bytes:
                            raise RuntimeError("Decode stream ended early")
                        tensor = (
                            np.frombuffer(frame, dtype=np.uint8)
                            .reshape(320, 320, 3)
                            .transpose(2, 0, 1)[None]
                            .astype(np.float32)
                            / 255
                        )
                        start = time.monotonic()
                        model.run(None, {name: tensor})
                        phase["inference_ms"].append((time.monotonic() - start) * 1000)
                        phase["frames"][index] += 1
                phase["ended"] = time.time()
                save()
            finally:
                for process in processes:
                    process.terminate()
                for process in processes:
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    finally:
        stop.set()
        thread.join(timeout=4)
        save()


if __name__ == "__main__":
    main()
