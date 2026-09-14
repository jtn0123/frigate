"""Opt-in GPU regression test for rotated H.265 startup."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(
    os.environ.get("FFMPEG_TEST_BIN") and os.environ.get("VAAPI_TEST_DEVICE"),
    "Set FFMPEG_TEST_BIN and VAAPI_TEST_DEVICE to run the GPU integration test",
)
class TestHEVCKeyframePipeline(unittest.TestCase):
    """Verify real encoder behavior without opening a camera connection."""

    def test_rotated_hevc_bounds_keyframe_wait_without_dropping_frames(self):
        """Bound startup wait while retaining every frame through GPU rotation."""
        ffmpeg = Path(os.environ["FFMPEG_TEST_BIN"])
        ffprobe = ffmpeg.with_name("ffprobe")
        device = os.environ["VAAPI_TEST_DEVICE"]

        def encode(args):
            result = subprocess.run(
                [str(ffmpeg), "-hide_banner", "-v", "error", "-y", *args],
                capture_output=True,
                text=True,
                timeout=40,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        def keyframes(path):
            result = subprocess.run(
                [
                    str(ffprobe),
                    "-v",
                    "error",
                    "-select_streams",
                    "v",
                    "-show_frames",
                    "-show_entries",
                    "frame=key_frame,best_effort_timestamp_time",
                    "-of",
                    "json",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=20,
                check=True,
            )
            return [
                round(float(frame["best_effort_timestamp_time"]), 3)
                for frame in json.loads(result.stdout)["frames"]
                if frame["key_frame"]
            ]

        with tempfile.TemporaryDirectory(prefix="hevc-keyframe-test-") as directory:
            root = Path(directory)
            source = root / "source.mp4"
            encode(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=640x360:rate=25",
                    "-t",
                    "2",
                    "-c:v",
                    "libx264",
                    "-threads",
                    "2",
                    "-preset",
                    "ultrafast",
                    "-g",
                    "250",
                    "-sc_threshold",
                    "0",
                    "-force_key_frames",
                    "0,0.32,0.92,1.72",
                    str(source),
                ]
            )
            expected = keyframes(source)
            self.assertEqual(expected, [0.0, 0.32, 0.92, 1.72])
            observed = {}
            for name, extra in (
                ("baseline", []),
                ("short_gop", ["-g", "12"]),
            ):
                output = root / f"{name}.mp4"
                encode(
                    [
                        "-init_hw_device",
                        f"vaapi=rotation:{device}",
                        "-filter_hw_device",
                        "rotation",
                        "-hwaccel",
                        "vaapi",
                        "-hwaccel_output_format",
                        "vaapi",
                        "-i",
                        str(source),
                        "-vf",
                        "transpose_vaapi=1",
                        "-c:v",
                        "hevc_vaapi",
                        "-g",
                        "25",
                        "-bf",
                        "0",
                        "-b:v",
                        "1000k",
                        "-bsf:v",
                        "hevc_metadata=width=360:height=640",
                        *extra,
                        str(output),
                    ]
                )
                observed[name] = keyframes(output)
                result = subprocess.run(
                    [
                        str(ffprobe),
                        "-v",
                        "error",
                        "-count_frames",
                        "-select_streams",
                        "v:0",
                        "-show_entries",
                        "stream=nb_read_frames,width,height",
                        "-of",
                        "json",
                        str(output),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=True,
                )
                stream = json.loads(result.stdout)["streams"][0]
                self.assertEqual(int(stream["nb_read_frames"]), 50)
                self.assertEqual((stream["width"], stream["height"]), (360, 640))
            self.assertEqual(observed["baseline"], [0.0, 1.0])
            self.assertEqual(observed["short_gop"], [0.0, 0.48, 0.96, 1.44, 1.92])
