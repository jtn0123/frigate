"""Exercise benchmark aborts, input integrity and cleanup without camera workloads."""

import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import numpy as np


def load_script(name):
    """Replace GPU/model kernels while keeping benchmark control flow real."""
    spec = importlib.util.spec_from_file_location(
        f"benchmark_{name}_test", Path(__file__).with_name(f"{name}.py")
    )
    module = importlib.util.module_from_spec(spec)
    dependencies = {
        name: MagicMock()
        for name in (
            "onnxruntime",
            "ctranslate2",
            "faster_whisper",
            "faster_whisper.audio",
        )
    }
    with patch.dict(sys.modules, dependencies):
        spec.loader.exec_module(module)
    return module


class CapacitySafetyTests(unittest.TestCase):
    def setUp(self):
        self.module = load_script("capacity")
        self.sample = {
            "source_updated": 100,
            "detectors": {"gpu": {"inference_speed": 10}},
            "skipped": {"doorbell": 0},
        }

    def test_health_rejects_stale_slow_and_skipping_cameras(self):
        with patch.object(self.module.time, "time", return_value=110):
            self.assertTrue(self.module.healthy(self.sample))
            for field, value in (
                ("source_updated", 0),
                ("detectors", {"gpu": {"inference_speed": 31}}),
                ("skipped", {"doorbell": 0.6}),
            ):
                with self.subTest(field=field):
                    self.assertFalse(self.module.healthy({**self.sample, field: value}))

    def test_monitor_requires_five_healthy_samples_and_aborts_repeated_failures(self):
        stop, ready, active, save = Mock(), Mock(), Mock(), Mock()
        stop.is_set.side_effect = [False] * 5 + [True]
        active.is_set.return_value = False
        report = {"samples": []}
        with (
            patch.object(self.module, "stats", return_value=self.sample),
            patch.object(self.module, "healthy", return_value=True),
        ):
            self.module.monitor(report, stop, ready, active, save)
        ready.set.assert_called_once()
        self.assertEqual(len(report["samples"]), 5)
        for failure in (False, OSError("unavailable")):
            stop.is_set.side_effect = [False] * 3
            active.is_set.return_value = True
            with (
                patch.object(
                    self.module,
                    "stats",
                    side_effect=failure if failure else None,
                    return_value=self.sample,
                ),
                patch.object(self.module, "healthy", return_value=False),
                patch.object(
                    self.module.os, "_exit", side_effect=SystemExit
                ) as exit_process,
                self.assertRaises(SystemExit),
            ):
                self.module.monitor(report, stop, ready, active, save)
            exit_process.assert_called_once_with(75)
            self.assertIn("aborted", report)
        self.assertEqual(save.call_count, 2)

    def test_decoded_frame_shape_and_truncated_stream(self):
        process, model = Mock(), Mock()
        process.stdout.read.return_value = bytes([255]) * (320 * 320 * 3)
        phase = {"frames": [0], "inference_ms": []}
        with patch.object(
            self.module.time, "monotonic", side_effect=[0, 0, 1, 1.02, 10]
        ):
            self.module.consume_frames([process], model, "image", phase, 1)
        tensor = model.run.call_args.args[1]["image"]
        self.assertEqual(tensor.shape, (1, 3, 320, 320))
        self.assertTrue(np.all(tensor == 1))
        self.assertEqual(phase["frames"], [1])
        process.stdout.read.return_value = b"short"
        with (
            patch.object(self.module.time, "monotonic", side_effect=[0, 0]),
            self.assertRaisesRegex(RuntimeError, "ended early"),
        ):
            self.module.consume_frames([process], model, "image", phase, 1)

    def test_full_phase_cleanup_and_refusal_of_cpu_fallback(self):
        for providers in (["MIGraphXExecutionProvider"], ["CPUExecutionProvider"]):
            with (
                self.subTest(providers=providers),
                tempfile.TemporaryDirectory() as directory,
            ):
                process = Mock()
                process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 3)] + [
                    0
                ] * 6
                self.module.ort.get_available_providers.return_value = providers
                model = self.module.ort.InferenceSession.return_value
                model.get_providers.return_value = providers
                with (
                    patch.object(
                        sys,
                        "argv",
                        ["capacity", "--output", directory, "--seconds", "30"],
                    ),
                    patch.object(self.module.threading, "Thread"),
                    patch.object(self.module.threading, "Event"),
                    patch.object(self.module.shutil, "which", return_value="ffmpeg"),
                    patch.object(self.module.subprocess, "run"),
                    patch.object(
                        self.module.subprocess, "Popen", return_value=process
                    ) as spawn,
                    patch.object(self.module, "consume_frames"),
                ):
                    if providers == ["CPUExecutionProvider"]:
                        with self.assertRaisesRegex(
                            RuntimeError, "refusing CPU fallback"
                        ):
                            self.module.main()
                        spawn.assert_not_called()
                    else:
                        self.module.main()
                        report = json.loads(
                            (Path(directory) / "capacity.json").read_text()
                        )
                        self.assertEqual(
                            [p["extra_cameras"] for p in report["phases"]], [2, 4]
                        )
                        self.assertEqual(process.terminate.call_count, 6)
                        process.kill.assert_called_once()

    def test_no_workload_without_healthy_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            event = Mock()
            event.wait.return_value = False
            with (
                patch.object(sys, "argv", ["capacity", "--output", directory]),
                patch.object(self.module.threading, "Thread"),
                patch.object(self.module.threading, "Event", return_value=event),
                patch.object(self.module.subprocess, "run") as run,
            ):
                self.module.main()
            run.assert_not_called()
            self.assertIn(
                "No healthy baseline",
                json.loads((Path(directory) / "capacity.json").read_text())["aborted"],
            )


class SpeechSafetyTests(unittest.TestCase):
    def setUp(self):
        self.module = load_script("speech")

    def test_guard_waits_for_health_and_aborts_low_memory_or_missing_stats(self):
        for healthy, missing in ((True, False), (False, False), (False, True)):
            with (
                self.subTest(healthy=healthy, missing=missing),
                tempfile.TemporaryDirectory() as directory,
            ):
                args = SimpleNamespace(output=Path(directory), model="medium")
                stop, ready, active = Mock(), Mock(), Mock()
                stop.is_set.side_effect = [False] * (5 if healthy else 3) + [True]
                active.is_set.return_value = True
                sample = {
                    "detectors": {"gpu": {"inference_speed": 10}},
                    "cameras": {"doorbell": {"skipped_fps": 0}},
                }

                def response(*_args, **_kwargs):
                    if missing:
                        raise OSError("unavailable")
                    return io.StringIO(json.dumps(sample))

                with (
                    patch.object(
                        self.module.urllib.request, "urlopen", side_effect=response
                    ),
                    patch.object(
                        Path,
                        "read_text",
                        return_value="MemAvailable: 1048576 kB"
                        if healthy
                        else "MemAvailable: 1 kB",
                    ),
                    patch.object(
                        self.module.os, "_exit", side_effect=SystemExit
                    ) as exit_process,
                ):
                    if healthy:
                        self.module.guard(args, [], stop, ready, active)
                        ready.set.assert_called_once()
                        exit_process.assert_not_called()
                    else:
                        with self.assertRaises(SystemExit):
                            self.module.guard(args, [], stop, ready, active)
                        exit_process.assert_called_once_with(75)
                self.assertEqual(
                    (Path(directory) / "medium-aborted.txt").exists(), not healthy
                )

    def test_speech_resume_skips_saved_variants_and_rejects_modified_corpus(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.wav").write_bytes(b"public fixture")
            clip = {
                "id": "ar-1",
                "language": "ar",
                "file": "clip.wav",
                "reference": "reference",
                "english_reference": "meaning",
                "sha256": hashlib.sha256(b"public fixture").hexdigest(),
            }
            (root / "manifest.json").write_text(
                json.dumps({"dataset": "fixture", "revision": "fixed", "clips": [clip]})
            )
            model = self.module.WhisperModel.return_value
            model.transcribe.return_value = (
                [SimpleNamespace(text=" sample ")],
                SimpleNamespace(language="ar"),
            )
            self.module.decode_audio.return_value = np.linspace(
                -0.5, 0.5, 1600, dtype=np.float32
            )
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "speech",
                        "--root",
                        directory,
                        "--output",
                        directory,
                        "--model",
                        "medium",
                        "--weights",
                        "local",
                    ],
                ),
                patch.object(self.module.threading, "Thread"),
                patch.object(self.module.threading, "Event"),
            ):
                self.module.main()
                report = json.loads((root / "medium.json").read_text())
                self.assertEqual(
                    {r["variant"] for r in report["clips"]},
                    {"clean", "white_noise_10db"},
                )
                self.assertEqual(model.transcribe.call_count, 4)
                self.module.main()
                self.assertEqual(model.transcribe.call_count, 4)
                (root / "clip.wav").write_bytes(b"changed input")
                with self.assertRaisesRegex(ValueError, "Corpus hash mismatch"):
                    self.module.main()
                self.assertEqual(model.transcribe.call_count, 4)

    def test_speech_does_not_load_model_without_healthy_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            event = Mock()
            event.wait.return_value = False
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "speech",
                        "--root",
                        directory,
                        "--output",
                        directory,
                        "--model",
                        "medium",
                        "--weights",
                        "local",
                    ],
                ),
                patch.object(self.module.threading, "Thread"),
                patch.object(self.module.threading, "Event", return_value=event),
                self.assertRaises(TimeoutError),
            ):
                self.module.main()
            self.module.WhisperModel.assert_not_called()
