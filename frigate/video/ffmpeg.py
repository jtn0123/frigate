"""Manages ffmpeg processes for camera frame capture."""

import json
import logging
import queue
import subprocess as sp
import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from multiprocessing import Queue, Value
from multiprocessing.synchronize import Event as MpEvent
from typing import Any

from frigate.camera import CameraMetrics
from frigate.comms.inter_process import InterProcessRequestor
from frigate.comms.recordings_updater import (
    RecordingsDataSubscriber,
    RecordingsDataTypeEnum,
)
from frigate.config import CameraConfig, LoggerConfig
from frigate.config.camera.updater import (
    CameraConfigUpdateEnum,
    CameraConfigUpdateSubscriber,
)
from frigate.const import (
    PROCESS_PRIORITY_HIGH,
    RECORD_STREAM_TYPES,
    ROLE_TO_STREAM_TYPE,
    STREAM_TYPE_MAIN,
    STREAM_TYPE_SUB,
    STREAM_TYPE_TO_ROLE,
)
from frigate.log import LogPipe
from frigate.util.builtin import EventsPerSecond, get_record_segment_time
from frigate.util.ffmpeg import start_or_restart_ffmpeg, stop_ffmpeg
from frigate.util.image import (
    FrameManager,
    SharedMemoryFrameManager,
)
from frigate.util.process import FrigateProcess
from frigate.video.camera_outage import (
    CameraOutageTracker,
    outage_message,
    push_enabled,
)
from frigate.video.hwaccel_fallback import HwaccelFallback, fallback_state_path
from frigate.video.restart_log import RestartLog
from frigate.video.watchdog_state import WatchdogState

logger = logging.getLogger(__name__)

RECORD_GRACE_SECONDS = 90


def capture_frames(
    ffmpeg_process: sp.Popen[Any],
    config: CameraConfig,
    shm_frame_count: int,
    frame_index: int,
    frame_shape: tuple[int, int],
    frame_manager: FrameManager,
    frame_queue,
    fps: Value,
    skipped_fps: Value,
    current_frame: Value,
    stop_event: MpEvent,
) -> None:
    frame_size = frame_shape[0] * frame_shape[1]
    frame_rate = EventsPerSecond()
    frame_rate.start()
    skipped_eps = EventsPerSecond()
    skipped_eps.start()

    while not stop_event.is_set():
        # CameraWatchdog applies enabled updates onto this same CameraConfig
        # before it stops ffmpeg. Do not subscribe here: it would be rebuilt per
        # ffmpeg restart and strand a pipe in the idle main process config PUB.
        if not config.enabled:
            logger.debug(f"Stopping capture thread for disabled {config.name}")
            break

        fps.value = frame_rate.eps()
        skipped_fps.value = skipped_eps.eps()
        current_frame.value = datetime.now().timestamp()
        frame_name = f"{config.name}_frame{frame_index}"
        frame_buffer = frame_manager.write(frame_name)
        try:
            frame_buffer[:] = ffmpeg_process.stdout.read(frame_size)
        except Exception:
            # shutdown has been initiated
            if stop_event.is_set():
                break

            logger.error(f"{config.name}: Unable to read frames from ffmpeg process.")

            if ffmpeg_process.poll() is not None:
                logger.error(
                    f"{config.name}: ffmpeg process is not running. exiting capture thread..."
                )
                break

            continue

        frame_rate.update()

        # don't lock the queue to check, just try since it should rarely be full
        try:
            # add to the queue
            frame_queue.put((frame_name, current_frame.value), False)
            frame_manager.close(frame_name)
        except queue.Full:
            # if the queue is full, skip this frame
            skipped_eps.update()

        frame_index = 0 if frame_index == shm_frame_count - 1 else frame_index + 1


class CameraWatchdog(threading.Thread):
    def __init__(
        self,
        config: CameraConfig,
        shm_frame_count: int,
        frame_queue: Queue,
        camera_fps,
        skipped_fps,
        ffmpeg_pid,
        stalls,
        reconnects,
        detection_frame,
        stop_event,
        hwaccel_fallback=None,
        shared: WatchdogState | None = None,
    ):
        threading.Thread.__init__(self)
        self.logger = logging.getLogger(f"watchdog.{config.name}")
        self.config = config
        self.shm_frame_count = shm_frame_count
        self.capture_thread = None
        self.ffmpeg_detect_process = None
        self.logpipe = LogPipe(f"ffmpeg.{self.config.name}.detect")
        self.ffmpeg_other_processes: list[dict[str, Any]] = []
        self.camera_fps = camera_fps
        self.skipped_fps = skipped_fps
        self.ffmpeg_pid = ffmpeg_pid
        self.frame_queue = frame_queue
        self.frame_shape = self.config.frame_shape_yuv
        self.frame_size = self.frame_shape[0] * self.frame_shape[1]
        self.fps_overflow_count = 0
        self.frame_index = 0
        self.stop_event = stop_event
        self.sleeptime = self.config.ffmpeg.retry_interval
        self.reconnect_timestamps = deque()
        self.stalls = stalls
        self.reconnects = reconnects
        self.detection_frame = detection_frame
        # Fork (D10): software-decoding fallback for a crashing hwaccel path,
        # remembered across restarts (D14).
        self.hwaccel_fallback = HwaccelFallback(
            config, state_path=fallback_state_path(config.name)
        )
        self.hwaccel_fallback_flag = hwaccel_fallback
        # Fork: manager proxies the stats process reads (D11, D14, SV6).
        shared = shared or WatchdogState()
        self.hwaccel_fallback_since = shared.hwaccel_fallback_since
        self._publish_hwaccel_fallback()
        since, expires = self.hwaccel_fallback.since, self.hwaccel_fallback.expires
        if since is not None and expires is not None:
            self.logger.info(
                f"{config.name}: detect decodes in software, as it has since "
                f"{datetime.fromtimestamp(since):%Y-%m-%d %H:%M}, when hardware "
                "decoding kept crashing it. Hardware decoding is tried again after "
                f"{datetime.fromtimestamp(expires):%Y-%m-%d %H:%M}, or as soon as "
                "this camera's ffmpeg settings change."
            )
        # Fork (D11): restart history for Camera Health, throttled ffmpeg dumps.
        self.restart_log = RestartLog(config.name, self.logger, shared.restart_events)
        self._crash_logged: threading.Thread | None = None
        # Fork (SV6): one notification when the camera has delivered nothing
        # for a while, and one when it comes back.
        self.outage_tracker = CameraOutageTracker(
            config.name,
            self.logger,
            history=shared.outage_events,
            since=shared.outage_since,
            notify=self._notify_outage,
        )

        self.config_subscriber = CameraConfigUpdateSubscriber(
            None,
            {config.name: config},
            [
                CameraConfigUpdateEnum.enabled,
                CameraConfigUpdateEnum.ffmpeg,
                CameraConfigUpdateEnum.record,
            ],
        )
        self.requestor = InterProcessRequestor()
        self.was_enabled = self.config.enabled
        self.was_record_enabled_in_config = self.config.record.enabled_in_config
        self.was_record_sub_enabled = self.config.record.sub.enabled

        self.segment_subscriber = RecordingsDataSubscriber(RecordingsDataTypeEnum.all)
        self.latest_valid_segment_time: dict[str, float] = defaultdict(float)
        self.latest_invalid_segment_time: dict[str, float] = defaultdict(float)
        self.latest_cache_segment_time: dict[str, float] = defaultdict(float)
        self.record_enable_time: datetime | None = None
        self.stream_grace_until: dict[str, datetime] = {}

        # `valid` segments are published with the segment's start time, so the
        # gap between consecutive publishes can reach 2 * segment_time. Pad the
        # staleness threshold so it's never tighter than that worst case.
        self.record_stale_threshold: dict[str, int] = {
            stream_type: max(
                120, 2 * get_record_segment_time(self.config, stream_type) + 30
            )
            for stream_type in RECORD_STREAM_TYPES
        }

        # the sub stream usually shares its input, and therefore its ffmpeg
        # process, with detect, so it isn't in ffmpeg_other_processes and needs
        # its own staleness check
        self.detect_process_records_sub = False

        # Stall tracking (based on last processed frame)
        self._stall_timestamps: deque[float] = deque()
        self._stall_active: bool = False

        # Status caching to reduce message volume
        self._last_detect_status: str | None = None
        self._last_record_status: dict[str, str] = {}
        self._last_status_update_time: float = 0.0

    def _send_detect_status(self, status: str, now: float) -> None:
        """Send detect status only if changed or retry_interval has elapsed."""
        if (
            status != self._last_detect_status
            or (now - self._last_status_update_time) >= self.sleeptime
        ):
            self.requestor.send_data(f"{self.config.name}/status/detect", status)
            self._last_detect_status = status
            self._last_status_update_time = now

    def _send_record_status(self, stream_type: str, status: str, now: float) -> None:
        """Send a record stream's status only if changed or retry_interval has elapsed."""
        if (
            status != self._last_record_status.get(stream_type)
            or (now - self._last_status_update_time) >= self.sleeptime
        ):
            self.requestor.send_data(
                f"{self.config.name}/status/{STREAM_TYPE_TO_ROLE[stream_type]}", status
            )
            self._last_record_status[stream_type] = status
            self._last_status_update_time = now

    def _notify_outage(self, event: dict[str, Any]) -> None:
        """Fork (SV6): push an outage event, when the fork flag asks for it.

        `camera_monitoring` is the topic web push and MQTT already carry, so
        this needs no new delivery path; it is opt-in because it reuses the
        user's alert notifications.
        """
        if not push_enabled():
            return

        self.requestor.send_data(
            "camera_monitoring",
            json.dumps(
                {
                    "camera": self.config.name,
                    "state": event["state"],
                    "message": outage_message(event),
                }
            ),
        )

    def _check_outage(self, now: float, enabled: bool) -> None:
        """Fork (SV6): fold one watchdog tick into the outage tracker."""
        last_frame_time = (
            float(self.capture_thread.current_frame.value)
            if self.capture_thread is not None
            else 0.0
        )
        self.outage_tracker.update(
            now,
            enabled=enabled,
            last_frame_time=last_frame_time,
            record_enabled=self.config.record.enabled,
            last_segment_time=self.latest_valid_segment_time[STREAM_TYPE_MAIN],
        )

    def _check_hwaccel_fallback(self, lines: list[str] | None = None) -> None:
        """Fork (D10): stop decoding on the GPU if that keeps killing detect."""
        if lines is None:
            lines = list(self.logpipe.deque.copy())
        if not self.hwaccel_fallback.record_crash(lines):
            return
        self.logger.warning(
            f"{self.config.name}: hardware-accelerated decoding ended the detect stream "
            f"{self.hwaccel_fallback.threshold} times in "
            f"{self.hwaccel_fallback.window / 60:.0f} minutes, so it is now decoded in "
            f"software for the next {self.hwaccel_fallback.remember / 86400:.0f} days, "
            "also across restarts, or until this camera's ffmpeg settings change. "
            "To keep using the GPU, try a different hwaccel_args preset for this "
            f"camera. Last error: {self.hwaccel_fallback.reason}"
        )
        self._publish_hwaccel_fallback()

    def _hwaccel_fallback_expired(self) -> bool:
        """Fork (B5): end a remembered switch that ran out while running."""
        if not self.hwaccel_fallback.maybe_expire():
            return False
        self._publish_hwaccel_fallback()
        self.logger.info(
            "%s: detect decoded in software for %.0f days, so hardware decoding "
            "is tried again",
            self.config.name,
            self.hwaccel_fallback.remember / 86400,
        )
        return True

    def _publish_hwaccel_fallback(self) -> None:
        """Fork (D10, D14): mirror the fallback state into the camera stats."""
        if self.hwaccel_fallback_flag is not None:
            self.hwaccel_fallback_flag.value = int(self.hwaccel_fallback.active)
        if self.hwaccel_fallback_since is not None:
            self.hwaccel_fallback_since.value = self.hwaccel_fallback.since or 0.0

    def _reset_segment_times(self) -> None:
        self.latest_valid_segment_time.clear()
        self.latest_invalid_segment_time.clear()
        self.latest_cache_segment_time.clear()
        self.stream_grace_until.clear()

    def _grant_restart_grace(self, stream_types: list[str], now_utc: datetime) -> None:
        for stream_type in stream_types:
            self.stream_grace_until[stream_type] = now_utc + timedelta(
                seconds=max(
                    RECORD_GRACE_SECONDS, self.record_stale_threshold[stream_type]
                )
            )

    def _stream_staleness(self, stream_type: str, now_utc: datetime) -> str | None:
        """Return why the stream's segments are stale, or None if they're healthy."""
        # ffmpeg needs time to create a first segment after recording is
        # enabled and after a restart, per stream
        in_grace_period = (
            self.record_enable_time is not None
            and (now_utc - self.record_enable_time)
            < timedelta(seconds=RECORD_GRACE_SECONDS)
        ) or now_utc < self.stream_grace_until.get(stream_type, now_utc)

        if in_grace_period:
            return None

        latest_cache = self.latest_cache_segment_time[stream_type]
        latest_valid = self.latest_valid_segment_time[stream_type]
        latest_invalid = self.latest_invalid_segment_time[stream_type]

        def as_dt(timestamp: float) -> datetime:
            if timestamp > 0:
                return datetime.fromtimestamp(timestamp, tz=UTC)

            return now_utc - timedelta(seconds=1)

        stale_window = timedelta(seconds=self.record_stale_threshold[stream_type])

        if now_utc > (as_dt(latest_cache) + stale_window):
            return "No new recording segments were created"

        if now_utc > (as_dt(latest_valid) + stale_window):
            return "No new valid recording segments were created"

        if (
            latest_invalid > 0
            and now_utc > (as_dt(latest_invalid) + stale_window)
            and latest_valid <= latest_invalid
        ):
            return "No valid segments created since last invalid segment"

        return None

    def _recorded_streams(self, roles: list[Any]) -> list[str]:
        """Record stream types the given roles cover that are currently recording."""
        return [
            stream_type
            for role, stream_type in ROLE_TO_STREAM_TYPE.items()
            if role in roles and self.config.record.stream_enabled(stream_type)
        ]

    def _check_config_updates(self) -> dict[str, list[str]]:
        """Check for config updates and return the update dict."""
        return self.config_subscriber.check_for_updates()

    def _update_enabled_state(self) -> bool:
        """Fetch the latest config and update enabled state."""
        self._check_config_updates()
        return self.config.enabled

    def reset_capture_thread(
        self,
        terminate: bool = True,
        drain_output: bool = True,
        cause: str | None = None,
        lines: list[str] | None = None,
    ) -> None:
        if terminate:
            self.ffmpeg_detect_process.terminate()
            try:
                self.logger.info("Waiting for ffmpeg to exit gracefully...")

                if drain_output:
                    self.ffmpeg_detect_process.communicate(timeout=30)
                else:
                    self.ffmpeg_detect_process.wait(timeout=30)
            except sp.TimeoutExpired:
                self.logger.info("FFmpeg did not exit. Force killing...")
                self.ffmpeg_detect_process.kill()

                if drain_output:
                    self.ffmpeg_detect_process.communicate()
                else:
                    self.ffmpeg_detect_process.wait()

        # Update reconnects
        now = datetime.now().timestamp()
        self.reconnect_timestamps.append(now)
        while self.reconnect_timestamps and self.reconnect_timestamps[0] < now - 3600:
            self.reconnect_timestamps.popleft()
        if self.reconnects:
            self.reconnects.value = len(self.reconnect_timestamps)

        # Wait for old capture thread to fully exit before starting a new one
        if self.capture_thread is not None and self.capture_thread.is_alive():
            self.logger.info("Waiting for capture thread to exit...")
            self.capture_thread.join(timeout=5)

            if self.capture_thread.is_alive():
                self.logger.warning(
                    f"Capture thread for {self.config.name} did not exit in time"
                )

        self.restart_log.note_exit("detect", self.logpipe, cause, lines=lines)
        self.logger.info("Restarting ffmpeg...")
        self.start_ffmpeg_detect()

        # this process produces the sub stream's segments too, so it gets the
        # same startup grace however the reset was triggered
        if self.detect_process_records_sub:
            self._grant_restart_grace([STREAM_TYPE_SUB], datetime.now().astimezone(UTC))

    def _drain_segment_updates(self) -> None:
        """Consume pending recording timestamps for this camera."""
        while True:
            update = self.segment_subscriber.check_for_update(timeout=0)

            if update == (None, None):
                break

            raw_topic, payload = update
            if not raw_topic or not payload:
                continue
            topic = str(raw_topic)
            camera, stream_type, segment_time, _ = payload

            if camera != self.config.name:
                continue

            if topic.endswith(RecordingsDataTypeEnum.invalid.value):
                self.logger.warning(
                    f"Invalid recording segment detected for {camera} at {segment_time}"
                )
                self.latest_invalid_segment_time[stream_type] = segment_time
            elif topic.endswith(RecordingsDataTypeEnum.valid.value):
                self.logger.debug(
                    f"Latest valid recording segment time on {camera}: {segment_time}"
                )
                self.latest_valid_segment_time[stream_type] = segment_time
            elif topic.endswith(RecordingsDataTypeEnum.latest.value):
                self.latest_cache_segment_time[stream_type] = (
                    segment_time if segment_time is not None else 0
                )

    def _check_detect_process(self, now: float, can_restart: bool) -> bool:
        """Check capture health and report whether detect was restarted."""
        if not self.capture_thread.is_alive():
            self._send_detect_status("offline", now)
            self.camera_fps.value = 0
            # fork (D11): once per crash, not every second until the retry
            if self._crash_logged is not self.capture_thread:
                self._crash_logged = self.capture_thread
                self.logger.error(
                    f"Ffmpeg process crashed unexpectedly for {self.config.name}."
                )
            if can_restart:
                # fork (B5): one snapshot, so both classify the same lines
                lines = list(self.logpipe.deque.copy())
                self._check_hwaccel_fallback(lines)
                self.reset_capture_thread(terminate=False, lines=lines)
                return True
        elif self.camera_fps.value >= (self.config.detect.fps + 10):
            self.fps_overflow_count += 1

            if self.fps_overflow_count == 3:
                self._send_detect_status("offline", now)
                self.fps_overflow_count = 0
                self.camera_fps.value = 0
                self.logger.info(
                    f"{self.config.name} exceeded fps limit. Exiting ffmpeg..."
                )
                if can_restart:
                    self.reset_capture_thread(
                        drain_output=False, cause="exceeded the fps limit"
                    )
                    return True
        elif now - self.capture_thread.current_frame.value > 20:
            self._send_detect_status("offline", now)
            self.camera_fps.value = 0
            self.logger.info(
                f"No frames received from {self.config.name} in 20 seconds. Exiting ffmpeg..."
            )
            if can_restart:
                self.reset_capture_thread(cause="no frames for 20 seconds")
                return True
        else:
            # process is running normally
            self._send_detect_status("online", now)
            self.fps_overflow_count = 0

        return False

    def _record_stall_reason(self, now: datetime) -> str | None:
        """Return the main recording stream's first stale-segment reason."""
        return self._stream_staleness(STREAM_TYPE_MAIN, now)

    def _restart_stalled_record(
        self, process: dict, now: datetime, reason: str
    ) -> None:
        """Restart a stalled recorder once and begin its recovery grace period."""
        self.logger.error(
            "%s for %s in the last %ss; restarting the ffmpeg record process",
            reason,
            self.config.name,
            self.record_stale_threshold[STREAM_TYPE_MAIN],
        )
        self._grant_restart_grace(self._recorded_streams(process["roles"]), now)
        # Fork (D58): upstream now dumps ffmpeg's output on this restart too.
        # Stop first so the output runs up to exit, then log it through the
        # restart log so a recurring stall is throttled like any exit (D11).
        stop_ffmpeg(process["process"], self.logger)
        self.restart_log.note_exit("record", process["logpipe"], cause=reason)
        process["process"] = start_or_restart_ffmpeg(
            process["cmd"],
            self.logger,
            process["logpipe"],
        )
        for role in process["roles"]:
            self.requestor.send_data(
                f"{self.config.name}/status/{role.value}", "offline"
            )

    def _check_record_processes(self, now: float, can_restart: bool = True) -> bool:
        """Check each recording stream and retain restart logging and grace."""
        restarted = False
        for process in self.ffmpeg_other_processes:
            poll = process["process"].poll()
            streams = self._recorded_streams(process["roles"])
            now_utc = datetime.now().astimezone(UTC)
            if streams:
                reason = next(
                    (
                        reason
                        for stream in streams
                        if (reason := self._stream_staleness(stream, now_utc))
                        is not None
                    ),
                    None,
                )
                if reason is not None and can_restart:
                    self._restart_stalled_record(process, now_utc, reason)
                    restarted = True
                    continue
                if reason is None:
                    for stream in streams:
                        self._send_record_status(stream, "online", now)
                    process["latest_segment_time"] = max(
                        self.latest_cache_segment_time[stream] for stream in streams
                    )
            if poll is None or not can_restart:
                continue
            for role in process["roles"]:
                self.requestor.send_data(
                    f"{self.config.name}/status/{role.value}", "offline"
                )
            self.restart_log.note_exit(
                "_".join(sorted(role.value for role in process["roles"])),
                process["logpipe"],
            )
            process["process"] = start_or_restart_ffmpeg(
                process["cmd"],
                self.logger,
                process["logpipe"],
                ffmpeg_process=process["process"],
            )
            self._grant_restart_grace(streams, now_utc)
            restarted = True
        return restarted

    def run(self) -> None:
        if self._update_enabled_state():
            self.start_all_ffmpeg()
            # If recording is enabled at startup, set the grace period timer
            if self.config.record.enabled:
                self.record_enable_time = datetime.now().astimezone(UTC)

        time.sleep(self.sleeptime)
        last_restart_time = datetime.now().timestamp()

        # 1 second watchdog loop
        while not self.stop_event.wait(1):
            updates = self._check_config_updates()

            # Fork (D30): changed ffmpeg settings retry hardware decoding even
            # while the camera is disabled, so re-enabling it starts on the GPU.
            if "ffmpeg" in updates:
                self.hwaccel_fallback.reset()
                self._publish_hwaccel_fallback()

            # Fork (B5): a switch that ran out restarts detect. A camera being
            # enabled or disabled this tick is handled below.
            hwaccel_expired = self._hwaccel_fallback_expired() and self.was_enabled

            # Fork (B10): only detect decodes, so only detect restarts, the way
            # the switch itself did. Recording keeps running, with no gap.
            if hwaccel_expired and self.config.enabled:
                self.logger.info(
                    "Restarting the detect ffmpeg process for %s to retry "
                    "hardware decoding",
                    self.config.name,
                )
                self.reset_capture_thread(cause="hwaccel retry")
                last_restart_time = datetime.now().timestamp()
                continue

            # Handle ffmpeg config changes by restarting all ffmpeg processes
            if "ffmpeg" in updates and self.config.enabled:
                self.logger.debug(
                    "FFmpeg config updated for %s, restarting ffmpeg processes",
                    self.config.name,
                )
                self.stop_all_ffmpeg()
                self.start_all_ffmpeg()
                self._reset_segment_times()
                self.record_enable_time = datetime.now().astimezone(UTC)
                last_restart_time = datetime.now().timestamp()
                continue

            enabled = self.config.enabled
            self._check_outage(datetime.now().timestamp(), enabled)  # fork (SV6)

            if enabled != self.was_enabled:
                if enabled:
                    self.logger.debug(f"Enabling camera {self.config.name}")
                    self.start_all_ffmpeg()

                    # reset all timestamps and record the enable time for grace period
                    self._reset_segment_times()
                    self.record_enable_time = datetime.now().astimezone(UTC)
                else:
                    self.logger.debug(f"Disabling camera {self.config.name}")
                    self.stop_all_ffmpeg()
                    self.record_enable_time = None

                    # update camera status
                    now = datetime.now().timestamp()
                    self._send_detect_status("disabled", now)
                    self._send_record_status(STREAM_TYPE_MAIN, "disabled", now)
                    # cameras without a sub stream never get a record_sub topic
                    if self.config.record.sub.enabled:
                        self._send_record_status(STREAM_TYPE_SUB, "disabled", now)
                self.was_enabled = enabled
                continue

            record_enabled_in_config = self.config.record.enabled_in_config
            if record_enabled_in_config != self.was_record_enabled_in_config:
                if record_enabled_in_config and enabled:
                    self.logger.debug(
                        f"Record enabled in config for {self.config.name}, restarting ffmpeg"
                    )
                    self.stop_all_ffmpeg()
                    self.start_all_ffmpeg()
                    self._reset_segment_times()
                    self.record_enable_time = datetime.now().astimezone(UTC)
                    last_restart_time = datetime.now().timestamp()
                self.was_record_enabled_in_config = record_enabled_in_config
                continue

            record_sub_enabled = self.config.record.sub.enabled
            if record_sub_enabled != self.was_record_sub_enabled:
                # adding and removing the record_sub output both require a
                # restart, unlike the main record toggle
                if record_enabled_in_config and enabled:
                    self.logger.debug(
                        f"Sub stream recording toggled in config for {self.config.name}, restarting ffmpeg"
                    )
                    self.stop_all_ffmpeg()
                    self.start_all_ffmpeg()
                    self._reset_segment_times()
                    self.record_enable_time = datetime.now().astimezone(UTC)
                    last_restart_time = datetime.now().timestamp()
                self.was_record_sub_enabled = record_sub_enabled
                continue

            if not enabled:
                continue

            self._drain_segment_updates()

            now = datetime.now().timestamp()

            # Check if enough time has passed to allow ffmpeg restart (backoff pacing)
            time_since_last_restart = now - last_restart_time
            can_restart = time_since_last_restart >= self.sleeptime

            if self._check_detect_process(now, can_restart):
                last_restart_time = now
            if self._check_record_processes(now, can_restart):
                last_restart_time = now

            if (
                self.detect_process_records_sub
                and self.config.record.stream_enabled(STREAM_TYPE_SUB)
                and self.capture_thread is not None
                and self.capture_thread.is_alive()
            ):
                now_utc = datetime.now().astimezone(UTC)
                stale_reason = self._stream_staleness(STREAM_TYPE_SUB, now_utc)

                if stale_reason is None:
                    self._send_record_status(STREAM_TYPE_SUB, "online", now)
                elif can_restart:
                    self.logger.error(
                        f"{stale_reason} for {self.config.name} (sub, shared with detect) in the last {self.record_stale_threshold[STREAM_TYPE_SUB]}s. Restarting ffmpeg..."
                    )
                    self._send_record_status(STREAM_TYPE_SUB, "offline", now)
                    self.reset_capture_thread()
                    last_restart_time = now

            # Prune expired reconnect timestamps
            now = datetime.now().timestamp()
            while (
                self.reconnect_timestamps and self.reconnect_timestamps[0] < now - 3600
            ):
                self.reconnect_timestamps.popleft()
            if self.reconnects:
                self.reconnects.value = len(self.reconnect_timestamps)

            # Update stall metrics based on last processed frame timestamp
            processed_ts = (
                float(self.detection_frame.value) if self.detection_frame else 0.0
            )
            if processed_ts > 0:
                delta = now - processed_ts
                observed_fps = (
                    self.camera_fps.value
                    if self.camera_fps.value > 0
                    else self.config.detect.fps
                )
                interval = 1.0 / max(observed_fps, 0.1)
                stall_threshold = max(2.0 * interval, 2.0)

                if delta > stall_threshold:
                    if not self._stall_active:
                        self._stall_timestamps.append(now)
                        self._stall_active = True
                else:
                    self._stall_active = False

                while self._stall_timestamps and self._stall_timestamps[0] < now - 3600:
                    self._stall_timestamps.popleft()

                if self.stalls:
                    self.stalls.value = len(self._stall_timestamps)

        self.stop_all_ffmpeg()
        self.logpipe.close()
        self.config_subscriber.stop()
        self.segment_subscriber.stop()

    def start_ffmpeg_detect(self):
        detect_cmd = [c for c in self.config.ffmpeg_cmds if "detect" in c["roles"]][0]
        ffmpeg_cmd = self.hwaccel_fallback.detect_cmd() or detect_cmd["cmd"]
        self.detect_process_records_sub = "record_sub" in detect_cmd["roles"]
        self.ffmpeg_detect_process = start_or_restart_ffmpeg(
            ffmpeg_cmd, self.logger, self.logpipe, self.frame_size
        )
        self.ffmpeg_pid.value = self.ffmpeg_detect_process.pid
        self.capture_thread = CameraCaptureRunner(
            self.config,
            self.shm_frame_count,
            self.frame_index,
            self.ffmpeg_detect_process,
            self.frame_shape,
            self.frame_queue,
            self.camera_fps,
            self.skipped_fps,
            self.stop_event,
        )
        self.capture_thread.start()

    def start_all_ffmpeg(self):
        """Start all ffmpeg processes (detection and others)."""
        logger.debug(f"Starting all ffmpeg processes for {self.config.name}")
        self.start_ffmpeg_detect()
        for c in self.config.ffmpeg_cmds:
            if "detect" in c["roles"]:
                continue
            logpipe = LogPipe(
                f"ffmpeg.{self.config.name}.{'_'.join(sorted(c['roles']))}"
            )
            self.ffmpeg_other_processes.append(
                {
                    "cmd": c["cmd"],
                    "roles": c["roles"],
                    "logpipe": logpipe,
                    "process": start_or_restart_ffmpeg(c["cmd"], self.logger, logpipe),
                }
            )

    def stop_all_ffmpeg(self):
        """Stop all ffmpeg processes (detection and others)."""
        logger.debug(f"Stopping all ffmpeg processes for {self.config.name}")
        if self.capture_thread is not None and self.capture_thread.is_alive():
            self.capture_thread.join(timeout=5)
            if self.capture_thread.is_alive():
                self.logger.warning(
                    f"Capture thread for {self.config.name} did not stop gracefully."
                )
        if self.ffmpeg_detect_process is not None:
            stop_ffmpeg(self.ffmpeg_detect_process, self.logger)
            self.ffmpeg_detect_process = None
        for p in self.ffmpeg_other_processes[:]:
            if p["process"] is not None:
                stop_ffmpeg(p["process"], self.logger)
            p["logpipe"].close()
        self.ffmpeg_other_processes.clear()


class CameraCaptureRunner(threading.Thread):
    def __init__(
        self,
        config: CameraConfig,
        shm_frame_count: int,
        frame_index: int,
        ffmpeg_process,
        frame_shape: tuple[int, int],
        frame_queue: Queue,
        fps: Value,
        skipped_fps: Value,
        stop_event: MpEvent,
    ):
        threading.Thread.__init__(self)
        self.name = f"capture:{config.name}"
        self.config = config
        self.shm_frame_count = shm_frame_count
        self.frame_index = frame_index
        self.frame_shape = frame_shape
        self.frame_queue = frame_queue
        self.fps = fps
        self.stop_event = stop_event
        self.skipped_fps = skipped_fps
        self.frame_manager = SharedMemoryFrameManager()
        self.ffmpeg_process = ffmpeg_process
        self.current_frame = Value("d", 0.0)
        self.last_frame = 0

    def run(self):
        capture_frames(
            self.ffmpeg_process,
            self.config,
            self.shm_frame_count,
            self.frame_index,
            self.frame_shape,
            self.frame_manager,
            self.frame_queue,
            self.fps,
            self.skipped_fps,
            self.current_frame,
            self.stop_event,
        )


class CameraCapture(FrigateProcess):
    def __init__(
        self,
        config: CameraConfig,
        shm_frame_count: int,
        camera_metrics: CameraMetrics,
        stop_event: MpEvent,
        log_config: LoggerConfig | None = None,
    ) -> None:
        super().__init__(
            stop_event,
            PROCESS_PRIORITY_HIGH,
            name=f"frigate.capture:{config.name}",
            daemon=True,
        )
        self.config = config
        self.shm_frame_count = shm_frame_count
        self.camera_metrics = camera_metrics
        self.log_config = log_config

    def run(self) -> None:
        self.pre_run_setup(self.log_config)
        camera_watchdog = CameraWatchdog(
            self.config,
            self.shm_frame_count,
            self.camera_metrics.frame_queue,
            self.camera_metrics.camera_fps,
            self.camera_metrics.skipped_fps,
            self.camera_metrics.ffmpeg_pid,
            self.camera_metrics.stalls_last_hour,
            self.camera_metrics.reconnects_last_hour,
            self.camera_metrics.detection_frame,
            self.stop_event,
            self.camera_metrics.hwaccel_fallback,
            WatchdogState(
                restart_events=self.camera_metrics.restart_events,
                hwaccel_fallback_since=self.camera_metrics.hwaccel_fallback_since,
                outage_events=self.camera_metrics.outage_events,
                outage_since=self.camera_metrics.outage_since,
            ),
        )
        camera_watchdog.start()
        camera_watchdog.join()
