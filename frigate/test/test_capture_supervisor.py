"""Tests for restarting capture processes that died or hung (SV12)."""

import signal
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frigate.camera import capture_supervisor
from frigate.camera.capture_supervisor import (
    BACKOFF_SECONDS,
    CHECK_SECONDS,
    SETTLED_SECONDS,
    STUCK_SECONDS,
    CaptureSupervisor,
    describe_exit,
    leftover_ffmpeg,
    record_outputs,
    stop_leftover_ffmpeg,
    stop_process,
)
from frigate.camera.maintainer import CameraMaintainer
from frigate.stats.util import watchdog_age

NOW = 1_790_000_000.0


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> float:
        return self.now


def value(initial: float) -> SimpleNamespace:
    return SimpleNamespace(value=initial)


def metrics(heartbeat: float = 0.0) -> SimpleNamespace:
    return SimpleNamespace(
        camera_fps=value(100.0),
        skipped_fps=value(45.4),
        ffmpeg_pid=value(4321),
        watchdog_heartbeat=value(heartbeat),
        restart_events=[],
    )


class TestVerdict(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.supervisor = CaptureSupervisor(self.clock)

    def test_running_process_with_a_fresh_heartbeat_is_left_alone(self) -> None:
        self.assertIsNone(self.supervisor.verdict("doorbell", 10, True, None, NOW - 3))

    def test_new_process_gets_time_before_its_first_heartbeat(self) -> None:
        self.assertIsNone(self.supervisor.verdict("doorbell", 10, True, None, 0))
        self.clock.now += STUCK_SECONDS - 1
        self.assertIsNone(self.supervisor.verdict("doorbell", 10, True, None, 0))

    def test_dead_process_is_restarted_at_once(self) -> None:
        verdict = self.supervisor.verdict("doorbell", 10, False, -9, NOW - 3)

        assert verdict is not None
        self.assertEqual(verdict.reason, "died")
        self.assertIn("memory ran out", verdict.message)

    def test_silent_watchdog_is_stuck(self) -> None:
        self.supervisor.verdict("doorbell", 10, True, None, NOW)
        self.clock.now += STUCK_SECONDS

        verdict = self.supervisor.verdict("doorbell", 10, True, None, NOW)

        assert verdict is not None
        self.assertEqual(verdict.reason, "stuck")
        self.assertIn(f"{STUCK_SECONDS} seconds", verdict.message)

    def test_process_that_never_reports_is_stuck(self) -> None:
        self.supervisor.verdict("doorbell", 10, True, None, 0)
        self.clock.now += STUCK_SECONDS

        verdict = self.supervisor.verdict("doorbell", 10, True, None, 0)

        assert verdict is not None
        self.assertEqual(verdict.reason, "stuck")

    def test_replaced_process_starts_the_clock_again(self) -> None:
        self.supervisor.verdict("doorbell", 10, True, None, NOW)
        self.clock.now += STUCK_SECONDS * 4

        # the maintainer swapped the process (camera refresh) with new metrics
        self.assertIsNone(self.supervisor.verdict("doorbell", 11, True, None, 0))

    def test_repeated_deaths_wait_longer_each_time(self) -> None:
        pid = 10
        for pause in BACKOFF_SECONDS:
            self.assertIsNotNone(self.supervisor.verdict("doorbell", pid, False, 1, 0))
            pid += 1
            self.clock.now += pause - 1
            self.assertIsNone(self.supervisor.verdict("doorbell", pid, False, 1, 0))
            self.clock.now += 1

        # past the end of the table the last pause repeats
        self.assertIsNotNone(self.supervisor.verdict("doorbell", pid, False, 1, 0))
        self.clock.now += BACKOFF_SECONDS[-1] - 1
        self.assertIsNone(self.supervisor.verdict("doorbell", pid + 1, False, 1, 0))

    def test_settled_process_clears_the_backoff(self) -> None:
        self.assertIsNotNone(self.supervisor.verdict("doorbell", 10, False, 1, 0))
        self.assertIsNone(self.supervisor.verdict("doorbell", 11, True, None, 0))
        self.clock.now += SETTLED_SECONDS
        self.assertIsNone(
            self.supervisor.verdict("doorbell", 11, True, None, self.clock.now)
        )

        # so the next death is restarted at once again
        self.assertNotIn("doorbell", self.supervisor.attempts)
        self.assertIsNotNone(self.supervisor.verdict("doorbell", 11, False, 1, 0))

    def test_cameras_are_judged_separately(self) -> None:
        self.assertIsNotNone(self.supervisor.verdict("doorbell", 10, False, 1, 0))
        self.assertIsNotNone(self.supervisor.verdict("backyard", 20, False, 1, 0))

    def test_due_limits_how_often_the_maintainer_checks(self) -> None:
        self.assertTrue(self.supervisor.due())
        self.assertFalse(self.supervisor.due())
        self.clock.now += CHECK_SECONDS
        self.assertTrue(self.supervisor.due())


class TestDescribeExit(unittest.TestCase):
    def test_messages(self) -> None:
        self.assertEqual(describe_exit(None), "capture process stopped")
        self.assertIn("signal 9", describe_exit(-signal.SIGKILL))
        self.assertEqual(
            describe_exit(-signal.SIGSEGV),
            f"capture process was stopped by signal {int(signal.SIGSEGV)}",
        )
        self.assertEqual(describe_exit(3), "capture process exited with code 3")


def ffmpeg(pid: int, cmdline: list[str], name: str = "ffmpeg") -> MagicMock:
    process = MagicMock()
    process.info = {"pid": pid, "name": name, "cmdline": cmdline}
    return process


class TestLeftoverFfmpeg(unittest.TestCase):
    def setUp(self) -> None:
        main, sub = sorted(record_outputs("doorbell"), key=len)
        self.recorder = ffmpeg(50, ["ffmpeg", "-i", "rtsp://x", main])
        self.sub_recorder = ffmpeg(51, ["ffmpeg", "-i", "rtsp://x", sub])
        self.detect = ffmpeg(4321, ["ffmpeg", "-i", "rtsp://x", "pipe:"])
        self.other_camera = ffmpeg(
            60, ["ffmpeg", "-i", "rtsp://x", *record_outputs("doorbell_2")]
        )
        self.reader = ffmpeg(61, ["ffmpeg", "-i", "/tmp/cache/doorbell@2026.mp4"])
        self.not_ffmpeg = ffmpeg(62, ["python3", main], name="python3")
        self.gone = ffmpeg(63, None)  # type: ignore[arg-type]
        self.all = [
            self.recorder,
            self.sub_recorder,
            self.detect,
            self.other_camera,
            self.reader,
            self.not_ffmpeg,
            self.gone,
        ]

    def test_finds_only_this_cameras_recorders_and_detect(self) -> None:
        with patch.object(
            capture_supervisor.psutil, "process_iter", return_value=self.all
        ):
            found = leftover_ffmpeg("doorbell", 4321)

        self.assertEqual(found, [self.recorder, self.sub_recorder, self.detect])

    def test_stops_them_and_kills_what_ignores_the_signal(self) -> None:
        self.recorder.terminate.side_effect = capture_supervisor.psutil.NoSuchProcess(
            50
        )
        self.detect.kill.side_effect = capture_supervisor.psutil.NoSuchProcess(4321)
        with (
            patch.object(
                capture_supervisor.psutil, "process_iter", return_value=self.all
            ),
            patch.object(
                capture_supervisor.psutil,
                "wait_procs",
                return_value=([], [self.sub_recorder, self.detect]),
            ),
        ):
            count = stop_leftover_ffmpeg("doorbell", 4321)

        self.assertEqual(count, 3)
        self.sub_recorder.terminate.assert_called_once()
        self.sub_recorder.kill.assert_called_once()
        self.recorder.kill.assert_not_called()
        self.other_camera.terminate.assert_not_called()


class TestStopProcess(unittest.TestCase):
    def test_terminate_is_enough(self) -> None:
        process = MagicMock()
        process.is_alive.return_value = False

        stop_process(process)

        process.terminate.assert_called_once()
        process.kill.assert_not_called()

    def test_kills_a_process_that_ignores_terminate(self) -> None:
        process = MagicMock()
        process.is_alive.return_value = True

        stop_process(process)

        process.kill.assert_called_once()
        self.assertEqual(process.join.call_count, 2)


class TestRestartNeeded(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.supervisor = CaptureSupervisor(self.clock)
        stop = patch.object(capture_supervisor, "stop_leftover_ffmpeg", return_value=1)
        self.stop_leftover = stop.start()
        self.addCleanup(stop.stop)

    def test_healthy_process_changes_nothing(self) -> None:
        process = MagicMock(pid=10, exitcode=None)
        process.is_alive.return_value = True
        shared = metrics(NOW)

        self.assertFalse(self.supervisor.restart_needed("doorbell", process, shared))
        self.assertEqual(shared.camera_fps.value, 100.0)
        self.stop_leftover.assert_not_called()

    def test_dead_process_is_cleaned_up_and_recorded(self) -> None:
        process = MagicMock(pid=10, exitcode=-9)
        process.is_alive.return_value = False
        shared = metrics(NOW - 900)

        with self.assertLogs(capture_supervisor.logger, "ERROR") as logs:
            self.assertTrue(self.supervisor.restart_needed("doorbell", process, shared))

        self.stop_leftover.assert_called_once_with("doorbell", 4321)
        process.terminate.assert_not_called()
        self.assertEqual(shared.camera_fps.value, 0)
        self.assertEqual(shared.skipped_fps.value, 0)
        self.assertEqual(shared.ffmpeg_pid.value, 0)
        self.assertEqual(shared.watchdog_heartbeat.value, 0)
        self.assertEqual(len(shared.restart_events), 1)
        self.assertEqual(shared.restart_events[0]["role"], "capture")
        self.assertIn("signal 9", shared.restart_events[0]["message"])
        self.assertIn("doorbell", logs.output[0])

    def test_stuck_process_is_stopped_first(self) -> None:
        process = MagicMock(pid=10, exitcode=None)
        process.is_alive.side_effect = [True, False]
        shared = metrics(NOW)
        self.supervisor.verdict("doorbell", 10, True, None, NOW)
        self.clock.now += STUCK_SECONDS

        with self.assertLogs(capture_supervisor.logger, "ERROR"):
            self.assertTrue(self.supervisor.restart_needed("doorbell", process, shared))

        process.terminate.assert_called_once()
        self.assertIn("no progress", shared.restart_events[0]["message"])


class TestMaintainerSupervision(unittest.TestCase):
    def make(self) -> CameraMaintainer:
        maintainer = CameraMaintainer.__new__(CameraMaintainer)
        maintainer.capture_supervisor = MagicMock()
        maintainer.capture_supervisor.due.return_value = True
        maintainer.stop_event = MagicMock()
        maintainer.stop_event.is_set.return_value = False
        maintainer.config = SimpleNamespace(cameras={"doorbell": "config"})
        maintainer.camera_metrics = {"doorbell": "metrics"}
        maintainer.capture_processes = {"doorbell": "process"}
        maintainer._CameraMaintainer__start_camera_capture = MagicMock()
        return maintainer

    def supervise(self, maintainer: CameraMaintainer) -> MagicMock:
        maintainer._CameraMaintainer__supervise_captures()
        return maintainer._CameraMaintainer__start_camera_capture

    def test_starts_a_new_process_when_needed(self) -> None:
        maintainer = self.make()
        maintainer.capture_supervisor.restart_needed.return_value = True

        start = self.supervise(maintainer)

        maintainer.capture_supervisor.restart_needed.assert_called_once_with(
            "doorbell", "process", "metrics"
        )
        start.assert_called_once_with("doorbell", "config")

    def test_leaves_healthy_processes_alone(self) -> None:
        maintainer = self.make()
        maintainer.capture_supervisor.restart_needed.return_value = False

        self.supervise(maintainer).assert_not_called()

    def test_does_nothing_between_checks(self) -> None:
        maintainer = self.make()
        maintainer.capture_supervisor.due.return_value = False

        self.supervise(maintainer)

        maintainer.capture_supervisor.restart_needed.assert_not_called()

    def test_skips_removed_cameras_and_shutdown(self) -> None:
        maintainer = self.make()
        maintainer.camera_metrics = {}
        self.supervise(maintainer)

        maintainer = self.make()
        maintainer.stop_event.is_set.return_value = True
        self.supervise(maintainer)

        maintainer.capture_supervisor.restart_needed.assert_not_called()


class TestWatchdogAge(unittest.TestCase):
    def test_none_before_the_first_report(self) -> None:
        self.assertIsNone(watchdog_age(0))

    def test_seconds_since_the_last_report(self) -> None:
        self.assertEqual(watchdog_age(NOW - 12.34, NOW), 12.3)

    def test_never_negative(self) -> None:
        self.assertEqual(watchdog_age(NOW + 5, NOW), 0.0)


if __name__ == "__main__":
    unittest.main()
