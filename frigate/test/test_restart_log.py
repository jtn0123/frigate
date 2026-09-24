"""Fork (D11): camera ffmpeg restart history and throttled ffmpeg dumps."""

import logging
import multiprocessing
import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import MagicMock

from frigate.video.ffmpeg import CameraWatchdog
from frigate.video.restart_log import (
    COALESCE_WINDOW_SECONDS,
    HISTORY_MAX,
    REPEAT_WINDOW_SECONDS,
    RestartLog,
    classify_exit,
)

VAAPI_EXIT = [
    "[AVHWFramesContext @ 0x767ddc0764c0] Failed to sync surface 0x3: 1 (operation failed).",
    "[hwdownload @ 0x767de4001f00] Failed to download frame: -5.",
    "[vf#0:0 @ 0x5f1c39b0f800] Error while filtering: Input/output error",
]
NETWORK_EXIT = [
    "[tcp @ 0x55d0c8e0a940] Connection to tcp://10.0.0.1:554 failed: Connection refused",
    "[in#0/rtsp @ 0x55d0c8e0a2c0] Error opening input: Connection refused",
]


class FakeLogPipe:
    def __init__(self, lines):
        self.deque = deque(lines, maxlen=100)
        self.dumped: list[list[str]] = []

    def dump(self):
        self.dumped.append(list(self.deque))
        self.deque.clear()


class TestClassifyExit(unittest.TestCase):
    def test_hardware_decoding(self):
        self.assertEqual(
            classify_exit(VAAPI_EXIT),
            ("hwaccel", "Failed to sync surface 0x3: 1 (operation failed)."),
        )

    def test_connection(self):
        kind, message = classify_exit(NETWORK_EXIT)
        self.assertEqual(kind, "connection")
        self.assertIn("Connection refused", message)

    def test_other_prefers_an_error_line(self):
        lines = [
            "frame=  10 fps=5",
            "[h264 @ 0x1] Invalid NAL unit size (-1 > 512)",
            "Error while decoding stream #0:0",
        ]
        self.assertEqual(
            classify_exit(lines), ("other", "Error while decoding stream #0:0")
        )

    def test_no_output(self):
        self.assertEqual(classify_exit([]), ("other", "exited without any output"))


class TestRestartLog(unittest.TestCase):
    def setUp(self):
        self.logger = logging.getLogger("watchdog.back")
        self.history: list[dict] = []
        self.log = RestartLog("back", self.logger, self.history)

    def test_first_exit_dumps_the_ffmpeg_output(self):
        pipe = FakeLogPipe(VAAPI_EXIT)

        # LogPipe.dump prints the heading itself (D58), so the restart log
        # adds none of its own and a dump never shows it twice.
        with self.assertNoLogs(self.logger, level="ERROR"):
            event = self.log.note_exit("detect", pipe, now=1000)

        self.assertEqual(pipe.dumped, [VAAPI_EXIT])
        self.assertEqual(event["kind"], "hwaccel")
        self.assertEqual(self.history, [event])

    def test_repeats_within_the_hour_log_one_line_with_a_count(self):
        self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1000)
        pipe = FakeLogPipe(VAAPI_EXIT)

        with self.assertLogs(self.logger, level="WARNING") as logs:
            self.log.note_exit("detect", pipe, now=1060)
        with self.assertLogs(self.logger, level="WARNING") as more:
            self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1120)

        self.assertEqual(len(logs.output), 1)
        self.assertIn(
            "ffmpeg exited again (hwaccel: Failed to sync surface", logs.output[0]
        )
        self.assertIn("That is 2 times since", logs.output[0])
        self.assertIn("That is 3 times since", more.output[0])
        self.assertEqual(pipe.dumped, [])
        self.assertEqual(
            len(pipe.deque), 0, "stale lines must not leak into the next exit"
        )
        self.assertEqual(len(self.history), 3)

    def test_repeat_warning_does_not_double_trailing_punctuation(self):
        self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1000)

        with self.assertLogs(self.logger, level="WARNING") as logs:
            self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1060)

        line = logs.output[0]
        self.assertNotIn(").).", line)
        self.assertIn(
            "ffmpeg exited again (hwaccel: Failed to sync surface 0x3: 1 "
            "(operation failed)).",
            line,
        )

    def test_the_full_output_is_logged_again_after_an_hour(self):
        self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1000)
        pipe = FakeLogPipe(VAAPI_EXIT)

        self.log.note_exit("detect", pipe, now=1000 + 3600)

        self.assertEqual(len(pipe.dumped), 1)

    def test_a_different_failure_gets_its_own_full_output(self):
        self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1000)
        pipe = FakeLogPipe(NETWORK_EXIT)

        self.log.note_exit("detect", pipe, now=1010)

        self.assertEqual(len(pipe.dumped), 1)

    def test_explicit_lines_win_over_a_pipe_that_changed_since(self):
        """B5: the caller's snapshot decides the kind, not a later read."""
        pipe = FakeLogPipe(NETWORK_EXIT)

        event = self.log.note_exit("detect", pipe, now=1000, lines=list(VAAPI_EXIT))

        self.assertEqual(event["kind"], "hwaccel")
        self.assertIn("Failed to sync surface", event["message"])
        self.assertEqual(len(pipe.deque), 0, "the pipe is still emptied")

    def test_watchdog_initiated_restarts_are_stalled(self):
        event = self.log.note_exit(
            "detect", FakeLogPipe([]), cause="no frames for 20 seconds", now=5
        )
        self.assertEqual(
            (event["kind"], event["message"]), ("stalled", "no frames for 20 seconds")
        )

    def test_history_keeps_24_hours_and_at_most_the_cap(self):
        self.log.record("record", "stalled", "old", now=0)
        self.log.record("record", "stalled", "new", now=90000)
        self.assertEqual([e["message"] for e in self.history], ["new"])

        step = COALESCE_WINDOW_SECONDS + 1
        for i in range(HISTORY_MAX + 5):
            self.log.record("detect", "other", str(i), now=90001 + i * step)
        self.assertEqual(len(self.history), HISTORY_MAX)
        self.assertEqual(self.history[-1]["message"], str(HISTORY_MAX + 4))

    def test_a_manager_list_is_trimmed_the_same_way(self):
        """B7: the shared history is a ListProxy; the trim is one slice write."""
        manager = multiprocessing.Manager()
        self.addCleanup(manager.shutdown)
        history = manager.list()
        log = RestartLog("back", self.logger, history)

        log.record("record", "stalled", "old", now=0)
        log.record("record", "stalled", "older than a day by now", now=50)
        log.record("detect", "other", "new", now=90000)

        self.assertEqual([e["message"] for e in history], ["new"])

    def test_only_leading_old_entries_are_dropped(self):
        # As before B7: trimming stops at the first entry that is recent enough.
        self.history.extend(
            [
                {"time": 0, "role": "detect", "kind": "other", "message": "a"},
                {"time": 80000, "role": "detect", "kind": "other", "message": "b"},
                {"time": 10, "role": "detect", "kind": "other", "message": "c"},
            ]
        )

        self.log.record("record", "stalled", "d", now=90000)

        self.assertEqual([e["message"] for e in self.history], ["b", "c", "d"])

    def test_signatures_past_the_repeat_window_are_forgotten(self):
        """B7: `_dumped` no longer grows with every distinct message."""
        for i in range(5):
            lines = [f"Error in module {chr(97 + i)}"]
            self.log.note_exit("detect", FakeLogPipe(lines), now=1000 + i * 100)
        self.assertEqual(len(self.log._dumped), 5)

        self.log.note_exit(
            "detect", FakeLogPipe(NETWORK_EXIT), now=1200 + REPEAT_WINDOW_SECONDS
        )

        # The exits at 1000, 1100 and 1200 are an hour old or more.
        self.assertEqual(len(self.log._dumped), 3)
        self.assertIn(("detect", "connection"), {key[:2] for key in self.log._dumped})

    def test_pruning_keeps_the_repeat_count_inside_the_window(self):
        self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1000)
        self.log.note_exit("detect", FakeLogPipe(NETWORK_EXIT), now=1000)
        pipe = FakeLogPipe(VAAPI_EXIT)

        with self.assertLogs(self.logger, level="WARNING") as logs:
            self.log.note_exit("detect", pipe, now=999 + REPEAT_WINDOW_SECONDS)

        self.assertIn("That is 2 times since", logs.output[0])
        self.assertEqual(pipe.dumped, [])


class TestBurstsAreOneIncident(unittest.TestCase):
    """Fork (SV5): a burst of restarts is one incident with a count."""

    def setUp(self):
        self.logger = logging.getLogger("watchdog.back")
        self.history: list[dict] = []
        self.log = RestartLog("back", self.logger, self.history)

    def test_a_single_restart_counts_once(self):
        event = self.log.record("record", "stalled", "no new segments", now=1000)

        self.assertEqual(event["count"], 1)
        self.assertEqual(self.history, [event])

    def test_restarts_seconds_apart_are_one_incident(self):
        self.log.record("record", "stalled", "no new segments", now=1000)
        self.log.record("record", "stalled", "no new segments", now=1001)
        event = self.log.record("record", "stalled", "no new segments", now=1009)

        self.assertEqual(len(self.history), 1)
        self.assertEqual(event["count"], 3)
        # The incident keeps the time of its first restart.
        self.assertEqual(event["time"], 1000)
        self.assertEqual(self.history[0], event)

    def test_a_restart_past_the_window_is_a_new_incident(self):
        self.log.record("record", "stalled", "no new segments", now=1000)
        self.log.record(
            "record", "stalled", "no new segments", now=1000 + COALESCE_WINDOW_SECONDS
        )
        self.log.record(
            "record",
            "stalled",
            "no new segments",
            now=1001 + COALESCE_WINDOW_SECONDS,
        )

        self.assertEqual([e["count"] for e in self.history], [2, 1])

    def test_a_different_role_or_kind_is_its_own_incident(self):
        self.log.record("record", "stalled", "no new segments", now=1000)
        self.log.record("detect", "stalled", "no frames", now=1001)
        self.log.record("detect", "connection", "Connection refused", now=1002)

        self.assertEqual(len(self.history), 3)
        self.assertEqual([e["count"] for e in self.history], [1, 1, 1])

    def test_the_event_keeps_the_fields_consumers_read(self):
        self.log.record("record", "stalled", "no new segments", now=1000)
        event = self.log.record("record", "stalled", "no new segments", now=1002)

        self.assertEqual(
            set(event.keys()), {"time", "role", "kind", "message", "count"}
        )
        self.assertEqual(event["role"], "record")
        self.assertEqual(event["kind"], "stalled")
        self.assertEqual(event["message"], "no new segments")

    def test_exits_seconds_apart_are_one_incident_too(self):
        self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1000)
        event = self.log.note_exit("detect", FakeLogPipe(VAAPI_EXIT), now=1003)

        self.assertEqual(len(self.history), 1)
        self.assertEqual(event["count"], 2)


class TestWatchdogResetHook(unittest.TestCase):
    """reset_capture_thread records the restart instead of always dumping."""

    def watchdog(self, lines):
        logger = logging.getLogger("watchdog.back")
        history: list[dict] = []
        return SimpleNamespace(
            config=SimpleNamespace(name="back"),
            logger=logger,
            logpipe=FakeLogPipe(lines),
            restart_log=RestartLog("back", logger, history),
            history=history,
            reconnect_timestamps=deque(),
            reconnects=None,
            capture_thread=None,
            start_ffmpeg_detect=MagicMock(),
        )

    def test_crash_is_classified_from_ffmpeg_output(self):
        watchdog = self.watchdog(VAAPI_EXIT)

        CameraWatchdog.reset_capture_thread(watchdog, terminate=False)

        self.assertEqual(watchdog.history[0]["kind"], "hwaccel")
        self.assertEqual(watchdog.history[0]["role"], "detect")
        watchdog.start_ffmpeg_detect.assert_called_once()

    def test_crash_uses_the_snapshot_it_is_given(self):
        """B5: the fallback check and the restart log see the same lines."""
        watchdog = self.watchdog(NETWORK_EXIT)

        CameraWatchdog.reset_capture_thread(
            watchdog, terminate=False, lines=list(VAAPI_EXIT)
        )

        self.assertEqual(watchdog.history[0]["kind"], "hwaccel")

    def test_stall_carries_the_watchdog_cause(self):
        watchdog = self.watchdog([])
        watchdog.ffmpeg_detect_process = MagicMock()

        CameraWatchdog.reset_capture_thread(watchdog, cause="no frames for 20 seconds")

        self.assertEqual(watchdog.history[0]["kind"], "stalled")
        watchdog.ffmpeg_detect_process.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
