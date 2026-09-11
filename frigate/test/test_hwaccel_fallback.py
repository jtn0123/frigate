"""Fork (D10): software-decoding fallback when hwaccel keeps crashing detect."""

import logging
import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frigate.config import FrigateConfig
from frigate.video.ffmpeg import CameraWatchdog
from frigate.video.hwaccel_fallback import (
    HwaccelFallback,
    hwaccel_failure_line,
    software_detect_cmd,
)

# What the detect process printed before each exit on the Tapo C120 behind a
# UHD 730 that prompted this (addresses and pointers vary per run).
VAAPI_CRASH_LOG = [
    "[AVHWFramesContext @ 0x767ddc0764c0] Failed to sync surface 0x3: 1 (operation failed).",
    "[hwdownload @ 0x767de4001f00] Failed to download frame: -5.",
    "[vf#0:0 @ 0x5f1c39b0f800] Error while filtering: Input/output error",
    "[vf#0:0 @ 0x5f1c39b0f800] Task finished with error code: -5 (Input/output error)",
]
NETWORK_CRASH_LOG = [
    "[tcp @ 0x55d0c8e0a940] Connection to tcp://127.0.0.1:8554 failed: Connection refused",
    "[in#0/rtsp @ 0x55d0c8e0a2c0] Error during demuxing: Input/output error",
]


def camera_config(hwaccel_args="preset-vaapi"):
    config = FrigateConfig(
        mqtt={"host": "mqtt"},
        # Set globally too, so config load does not probe for a GPU ("auto").
        ffmpeg={"hwaccel_args": hwaccel_args},
        cameras={
            "back": {
                "ffmpeg": {
                    "hwaccel_args": hwaccel_args,
                    "inputs": [
                        {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]},
                        {"path": "rtsp://10.0.0.1:554/record", "roles": ["record"]},
                    ],
                },
                "detect": {"width": 640, "height": 360, "fps": 5},
                "record": {"enabled": True},
            }
        },
    )
    return config.cameras["back"]


def detect_cmd(config):
    return next(c["cmd"] for c in config.ffmpeg_cmds if "detect" in c["roles"])


class TestHwaccelFailureLine(unittest.TestCase):
    def test_finds_the_vaapi_sync_failure(self):
        self.assertIn("Failed to sync surface", hwaccel_failure_line(VAAPI_CRASH_LOG))

    def test_ignores_network_and_demux_errors(self):
        self.assertIsNone(hwaccel_failure_line(NETWORK_CRASH_LOG))


class TestSoftwareDetectCmd(unittest.TestCase):
    def test_drops_hwaccel_and_scales_in_software(self):
        config = camera_config()
        hardware = " ".join(detect_cmd(config))
        software = " ".join(software_detect_cmd(config))

        self.assertIn("-hwaccel vaapi", hardware)
        self.assertIn("scale_vaapi", hardware)
        self.assertNotIn("-hwaccel", software)
        self.assertNotIn("vaapi", software)
        self.assertIn("scale=640:360", software)
        self.assertIn("rtsp://10.0.0.1:554/video", software)
        self.assertTrue(software.endswith("pipe:"))

    def test_leaves_the_live_config_alone(self):
        config = camera_config()
        before = detect_cmd(config)
        software_detect_cmd(config)
        self.assertEqual(detect_cmd(config), before)
        self.assertEqual(config.ffmpeg.hwaccel_args, "preset-vaapi")


class TestHwaccelFallback(unittest.TestCase):
    def test_switches_after_three_crashes_in_the_window(self):
        fallback = HwaccelFallback(camera_config())

        self.assertFalse(fallback.record_crash(VAAPI_CRASH_LOG, now=0))
        self.assertFalse(fallback.record_crash(VAAPI_CRASH_LOG, now=60))
        self.assertIsNone(fallback.detect_cmd())
        self.assertTrue(fallback.record_crash(VAAPI_CRASH_LOG, now=120))

        self.assertTrue(fallback.active)
        self.assertIn("Failed to sync surface", fallback.reason)
        self.assertNotIn("-hwaccel", fallback.detect_cmd())
        # Already switched: later exits do not report a switch again.
        self.assertFalse(fallback.record_crash(VAAPI_CRASH_LOG, now=180))

    def test_crashes_outside_the_window_do_not_add_up(self):
        fallback = HwaccelFallback(camera_config(), window=600)

        for now in (0, 400, 1100, 1600):
            self.assertFalse(fallback.record_crash(VAAPI_CRASH_LOG, now=now))
        self.assertFalse(fallback.active)

    def test_other_crashes_never_switch(self):
        fallback = HwaccelFallback(camera_config())

        for now in range(0, 50, 10):
            self.assertFalse(fallback.record_crash(NETWORK_CRASH_LOG, now=now))
        self.assertFalse(fallback.active)

    def test_nothing_to_do_when_already_decoding_in_software(self):
        fallback = HwaccelFallback(camera_config(hwaccel_args=[]))

        for now in (0, 10, 20):
            self.assertFalse(fallback.record_crash(VAAPI_CRASH_LOG, now=now))
        self.assertFalse(fallback.active)

    def test_reset_returns_to_the_configured_command(self):
        fallback = HwaccelFallback(camera_config(), threshold=1)
        self.assertTrue(fallback.record_crash(VAAPI_CRASH_LOG, now=0))

        fallback.reset()

        self.assertFalse(fallback.active)
        self.assertIsNone(fallback.detect_cmd())
        self.assertIsNone(fallback.reason)


class TestWatchdogHooks(unittest.TestCase):
    """The CameraWatchdog hunks, without its IPC and threads."""

    def watchdog(self, threshold=1):
        config = camera_config()
        return SimpleNamespace(
            config=config,
            logger=logging.getLogger("watchdog.back"),
            logpipe=SimpleNamespace(deque=deque(VAAPI_CRASH_LOG)),
            hwaccel_fallback=HwaccelFallback(config, threshold=threshold),
            hwaccel_fallback_flag=SimpleNamespace(value=0),
            frame_size=640 * 360 * 3 // 2,
            shm_frame_count=2,
            frame_index=0,
            frame_shape=(540, 640),
            frame_queue=None,
            camera_fps=None,
            skipped_fps=None,
            stop_event=None,
            ffmpeg_pid=SimpleNamespace(value=0),
        )

    def test_switch_is_logged_as_a_warning_and_published(self):
        watchdog = self.watchdog()

        with self.assertLogs("watchdog.back", level="WARNING") as logs:
            CameraWatchdog._check_hwaccel_fallback(watchdog)

        self.assertEqual(watchdog.hwaccel_fallback_flag.value, 1)
        self.assertIn("software", logs.output[0])
        self.assertIn("Failed to sync surface", logs.output[0])

    def test_no_warning_before_the_threshold(self):
        watchdog = self.watchdog(threshold=3)

        with self.assertNoLogs("watchdog.back", level="WARNING"):
            CameraWatchdog._check_hwaccel_fallback(watchdog)

        self.assertEqual(watchdog.hwaccel_fallback_flag.value, 0)

    @patch("frigate.video.ffmpeg.CameraCaptureRunner")
    @patch("frigate.video.ffmpeg.start_or_restart_ffmpeg")
    def test_detect_restarts_with_the_software_command(self, start, _runner):
        start.return_value = MagicMock(pid=1234)
        watchdog = self.watchdog()

        CameraWatchdog.start_ffmpeg_detect(watchdog)
        self.assertIn("-hwaccel", start.call_args.args[0])

        CameraWatchdog._check_hwaccel_fallback(watchdog)
        CameraWatchdog.start_ffmpeg_detect(watchdog)
        self.assertNotIn("-hwaccel", start.call_args.args[0])
        self.assertEqual(watchdog.ffmpeg_pid.value, 1234)


if __name__ == "__main__":
    unittest.main(verbosity=2)
