"""Keep video probe inputs separate from ffprobe command options."""

import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from frigate.util.services import ffprobe_stream


class TestFfprobeInput(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = SimpleNamespace(ffprobe_path="/usr/bin/ffprobe")

    def test_option_like_and_regular_inputs_are_explicit(self):
        for path in ("-show_format", "clip with spaces.mp4", "rtsp://camera/live"):
            with (
                self.subTest(path=path),
                patch(
                    "frigate.util.services.sp.run",
                    return_value=subprocess.CompletedProcess([], 0, b"{}", b""),
                ) as run,
            ):
                ffprobe_stream(self.ffmpeg, path, detailed=True)
                self.assertEqual(run.call_args.args[0][-2:], ["-i", path])
                self.assertEqual(run.call_args.kwargs["timeout"], 6)

    def test_tcp_retry_keeps_input_boundary(self):
        path = "rtsp://camera/live"
        with patch(
            "frigate.util.services.sp.run",
            side_effect=[
                subprocess.CompletedProcess([], 1, b"", b"failed"),
                subprocess.CompletedProcess([], 0, b"{}", b""),
            ],
        ) as run:
            result = ffprobe_stream(self.ffmpeg, path)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(run.call_args_list), 2)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][-2:], ["-i", path])
        self.assertEqual(run.call_args.args[0][1:3], ["-rtsp_transport", "tcp"])

    def test_timeout_remains_a_bounded_probe_failure(self):
        with patch(
            "frigate.util.services.sp.run",
            side_effect=subprocess.TimeoutExpired("ffprobe", 6),
        ):
            result = ffprobe_stream(self.ffmpeg, "-show_format")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.args[-2:], ["-i", "-show_format"])
        self.assertIn(b"timed out", result.stderr)
