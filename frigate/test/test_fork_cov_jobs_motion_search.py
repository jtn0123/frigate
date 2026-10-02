"""Coverage for the motion search job runner and job registry (fork D73)."""

import logging
import threading
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np
from playhouse.sqlite_ext import SqliteExtDatabase

from frigate.jobs import manager as job_manager
from frigate.jobs import motion_search as ms
from frigate.jobs.motion_search import (
    MotionSearchJob,
    MotionSearchMetrics,
    MotionSearchResult,
    MotionSearchRunner,
    build_vod_url,
    cancel_motion_search_job,
    compute_roi_bbox_normalized,
    create_polygon_mask,
    get_motion_search_job,
    heatmap_overlaps_roi,
    resolve_internal_port,
    segment_passes_activity_gate,
    segment_passes_heatmap_gate,
    start_motion_search_job,
    stop_all_motion_search_jobs,
)
from frigate.models import Recordings
from frigate.types import JobStatusTypesEnum

FULL_POLYGON = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
# Probed VOD dimensions; with the full polygon the ROI is the whole frame and
# never upscaled, so frames are (VOD_H, VOD_W).
VOD_W = 40
VOD_H = 20


def _black() -> np.ndarray:
    return np.zeros((VOD_H, VOD_W), dtype=np.uint8)


def _white() -> np.ndarray:
    return np.full((VOD_H, VOD_W), 255, dtype=np.uint8)


def _config(
    camera: str = "front",
    width: int | None = 1920,
    height: int | None = 1080,
    internal: int | str = 5000,
) -> Any:
    camera_config = SimpleNamespace(
        detect=SimpleNamespace(width=width, height=height),
        ffmpeg=SimpleNamespace(ffmpeg_path="/usr/bin/ffmpeg", ffprobe_path="/x/ffp"),
    )
    return SimpleNamespace(
        cameras={camera: camera_config},
        networking=SimpleNamespace(listen=SimpleNamespace(internal=internal)),
    )


def _rec(**kwargs: Any) -> SimpleNamespace:
    base: dict[str, Any] = {
        "motion": None,
        "objects": None,
        "regions": None,
        "motion_heatmap": None,
    }
    base.update(kwargs)
    return SimpleNamespace(**base)


class TestDataclasses(unittest.TestCase):
    def test_job_to_dict_includes_metrics_when_present(self):
        job = MotionSearchJob(camera="front")
        self.assertIsNone(job.to_dict()["metrics"])
        job.metrics = MotionSearchMetrics(frames_decoded=7)
        d = job.to_dict()
        self.assertEqual(d["metrics"]["frames_decoded"], 7)
        self.assertEqual(d["job_type"], "motion_search")
        self.assertEqual(d["camera"], "front")

    def test_result_to_dict(self):
        self.assertEqual(
            MotionSearchResult(timestamp=5.0, change_percentage=1.5).to_dict(),
            {"timestamp": 5.0, "change_percentage": 1.5},
        )


class TestPureHelpers(unittest.TestCase):
    def test_create_polygon_mask_fills_polygon_only(self):
        mask = create_polygon_mask([[0.0, 0.0], [0.5, 0.0], [0.5, 1.0]], 10, 10)
        self.assertEqual(mask.shape, (10, 10))
        self.assertEqual(mask[0, 0], 255)
        self.assertEqual(mask[0, 9], 0)

    def test_detect_motion_scaled_empty_mask_finds_nothing(self):
        frames = [(0, _black()), (1, _white())]
        mask = np.zeros((VOD_H, VOD_W), dtype=np.uint8)
        self.assertEqual(
            ms.detect_motion_scaled(frames, mask, 30, 5.0, float),
            [],
        )

    def test_roi_bbox_defaults_to_full_frame(self):
        self.assertEqual(compute_roi_bbox_normalized([]), (0.0, 0.0, 1.0, 1.0))

    def test_roi_bbox_from_points(self):
        self.assertEqual(
            compute_roi_bbox_normalized([[0.2, 0.4], [0.6, 0.1], [0.3, 0.9]]),
            (0.2, 0.1, 0.6, 0.9),
        )

    def test_heatmap_overlap_invalid_heatmap_is_conservative(self):
        self.assertTrue(heatmap_overlaps_roi([1, 2, 3], (0.0, 0.0, 0.1, 0.1)))

    def test_heatmap_overlap_hit_and_miss(self):
        # Cell 0 is the top-left grid cell; cell 255 is the bottom-right.
        self.assertTrue(heatmap_overlaps_roi({"0": 10}, (0.0, 0.0, 0.1, 0.1)))
        self.assertFalse(heatmap_overlaps_roi({"255": 10}, (0.0, 0.0, 0.1, 0.1)))
        self.assertTrue(heatmap_overlaps_roi({"255": 10}, (0.9, 0.9, 1.0, 1.0)))

    def test_activity_gate(self):
        self.assertTrue(segment_passes_activity_gate(_rec()))
        self.assertFalse(segment_passes_activity_gate(_rec(motion=0, objects=0)))
        self.assertTrue(segment_passes_activity_gate(_rec(motion=0, regions=2)))
        self.assertTrue(segment_passes_activity_gate(_rec(objects=1)))

    def test_heatmap_gate(self):
        bbox = (0.0, 0.0, 0.1, 0.1)
        self.assertTrue(segment_passes_heatmap_gate(_rec(), bbox))
        self.assertTrue(
            segment_passes_heatmap_gate(_rec(motion_heatmap={"0": 1}), bbox)
        )
        self.assertFalse(
            segment_passes_heatmap_gate(_rec(motion_heatmap={"255": 1}), bbox)
        )

    def test_resolve_internal_port_int_and_str(self):
        self.assertEqual(resolve_internal_port(_config(internal=5001)), 5001)
        self.assertEqual(
            resolve_internal_port(_config(internal="127.0.0.1:5002")), 5002
        )
        self.assertEqual(resolve_internal_port(_config(internal="5003")), 5003)

    def test_build_vod_url(self):
        self.assertEqual(
            build_vod_url(5000, "front", 1.5, 2.5),
            "http://127.0.0.1:5000/vod/front/start/1.5/end/2.5/index.m3u8",
        )


class RunnerTestCase(unittest.TestCase):
    """Runner tests against an in-memory Recordings table with mocked ffmpeg."""

    def setUp(self):
        self.db = SqliteExtDatabase(":memory:")
        self.db.bind([Recordings])
        self.db.create_tables([Recordings])

        self.requestor = MagicMock()
        requestor_patch = patch.object(
            ms, "InterProcessRequestor", return_value=self.requestor
        )
        requestor_patch.start()
        self.addCleanup(requestor_patch.stop)

        self.decode_args = patch.object(
            ms, "resolve_motion_decode_args", return_value=[]
        ).start()
        self.probe_dims = patch.object(
            ms, "probe_video_dimensions", return_value=(VOD_W, VOD_H, 10.0)
        ).start()
        self.probe_pts = patch.object(
            ms, "probe_vod_keyframe_pts", return_value=[0.0, 1.5, 3.0]
        ).start()
        self.iter_frames = patch.object(ms, "iter_vod_frames").start()
        self.addCleanup(patch.stopall)

    def tearDown(self):
        self.db.close()

    def _insert(
        self,
        rec_id: str,
        start: float,
        end: float,
        camera: str = "front",
        stream_type: str = "main",
        **extra: Any,
    ) -> None:
        Recordings.create(
            id=rec_id,
            camera=camera,
            path=f"/tmp/{rec_id}.mp4",
            start_time=start,
            end_time=end,
            duration=end - start,
            stream_type=stream_type,
            **extra,
        )

    def _runner(
        self,
        config: Any = None,
        polygon: list[list[float]] | None = None,
        start: float = 990.0,
        end: float = 2000.0,
        **job_kwargs: Any,
    ) -> MotionSearchRunner:
        job = MotionSearchJob(
            camera=job_kwargs.pop("camera", "front"),
            start_time_range=start,
            end_time_range=end,
            polygon_points=polygon if polygon is not None else FULL_POLYGON,
            **job_kwargs,
        )
        return MotionSearchRunner(job, config or _config(), threading.Event())

    def _sent_payloads(self) -> list[dict[str, Any]]:
        return [c.args[1] for c in self.requestor.send_data.call_args_list]


class TestRunnerEndToEnd(RunnerTestCase):
    def test_keyframe_mode_maps_probed_pts_to_absolute_times(self):
        self._insert("a", 1000.0, 1010.0, motion=5)
        self._insert("b", 1010.0, 1020.0, motion=5)
        # Other camera and sub stream rows must be ignored by the query.
        self._insert("other", 1000.0, 1010.0, camera="back")
        self._insert("sub", 1000.0, 1010.0, stream_type="sub")
        self.iter_frames.return_value = iter([_black(), _white(), _black()])

        runner = self._runner()
        runner.run()

        job = runner.job
        self.assertEqual(job.status, JobStatusTypesEnum.success)
        self.assertIsNone(job.error_message)
        timestamps = [r["timestamp"] for r in job.results["results"]]
        self.assertEqual(timestamps, [1001.5, 1003.0])
        for r in job.results["results"]:
            self.assertGreater(r["change_percentage"], 50.0)
        self.assertEqual(job.results["total_frames_processed"], 3)
        self.assertEqual(job.progress, 1.0)
        self.assertEqual(runner.metrics.segments_scanned, 2)
        self.assertEqual(runner.metrics.segments_processed, 2)
        self.assertEqual(runner.metrics.frames_decoded, 3)
        self.assertTrue(runner.use_keyframe)
        self.assertEqual(runner.crop, (VOD_W, VOD_H, 0, 0))
        self.assertEqual(runner.scaled, (VOD_W, VOD_H))
        self.assertEqual(runner.ffprobe_path, "/x/ffp")

        # One keyframe decode for the single coalesced run.
        self.iter_frames.assert_called_once()
        args, kwargs = self.iter_frames.call_args
        self.assertEqual(args[0], "/usr/bin/ffmpeg")
        self.assertEqual(
            args[1],
            "http://127.0.0.1:5000/vod/front/start/1000/end/1020/index.m3u8",
        )
        self.assertEqual(kwargs, {"skip_nonkey": True, "fps_rate": None})

        statuses = [p["status"] for p in self._sent_payloads()]
        self.assertEqual(statuses[0], JobStatusTypesEnum.running)
        self.assertEqual(statuses[-1], JobStatusTypesEnum.success)
        self.requestor.stop.assert_called_once()
        self.assertGreaterEqual(job.end_time, job.start_time)

    def test_keyframe_count_mismatch_falls_back_to_cadence(self):
        self._insert("a", 1000.0, 1010.0)
        # First decode (keyframes) yields 2 frames for 3 probed PTS, so the run
        # is re-decoded at the fixed cadence.
        self.iter_frames.side_effect = [
            iter([_black(), _white()]),
            iter([_black(), _white(), _black(), _black()]),
        ]

        runner = self._runner()
        runner.run()

        self.assertEqual(self.iter_frames.call_count, 2)
        self.assertEqual(
            self.iter_frames.call_args.kwargs, {"skip_nonkey": False, "fps_rate": 2.0}
        )
        # Cadence frames sit at i / 2.0 s: hits at 1000.5 and 1001.0, the second
        # is deduplicated (under 1 s apart).
        self.assertEqual(
            [r["timestamp"] for r in runner.job.results["results"]], [1000.5]
        )
        self.assertEqual(runner.job.total_frames_processed, 4)

    def test_sparse_keyframes_use_cadence_directly(self):
        self._insert("a", 1000.0, 1010.0)
        self.probe_pts.return_value = [0.0, 8.0]
        self.iter_frames.return_value = iter([_black(), _black()])

        runner = self._runner()
        runner.run()

        self.assertFalse(runner.use_keyframe)
        self.iter_frames.assert_called_once()
        self.assertEqual(self.iter_frames.call_args.kwargs["fps_rate"], 2.0)
        self.assertEqual(runner.job.results["results"], [])
        self.assertEqual(runner.job.status, JobStatusTypesEnum.success)

    def test_unknown_camera_fails_job(self):
        runner = self._runner(camera="missing")
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.failed)
        self.assertEqual(runner.job.error_message, "Camera missing not found")
        self.assertIsNotNone(runner.job.metrics)
        self.assertEqual(self._sent_payloads()[-1]["status"], JobStatusTypesEnum.failed)
        self.requestor.stop.assert_called_once()

    def test_missing_detect_dimensions_fails_job(self):
        runner = self._runner(config=_config(width=None))
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.failed)
        self.assertIn("detect dimensions not configured", runner.job.error_message)

    def test_empty_polygon_returns_no_results(self):
        self._insert("a", 1000.0, 1010.0)
        runner = self._runner()
        with patch.object(ms, "create_polygon_mask", return_value=np.zeros((2, 2))):
            runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.success)
        self.assertEqual(runner.job.results["results"], [])
        self.probe_dims.assert_not_called()

    def test_no_recordings_returns_no_results(self):
        runner = self._runner()
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.success)
        self.assertEqual(runner.job.results["results"], [])
        self.assertEqual(runner.metrics.segments_scanned, 0)
        self.probe_dims.assert_not_called()

    def test_range_inside_one_segment_matches_it(self):
        # The job range sits strictly inside one long segment.
        self._insert("long", 1000.0, 1100.0)
        self.iter_frames.return_value = iter([_black(), _black(), _black()])
        runner = self._runner(start=1020.0, end=1030.0)
        runner.run()
        self.assertEqual(runner.metrics.segments_scanned, 1)
        self.iter_frames.assert_called_once()

    def test_gates_skip_segments_and_count_metrics(self):
        # Inactive, heatmap-miss, and one active segment in the ROI.
        self._insert("idle", 1000.0, 1010.0, motion=0, objects=0, regions=0)
        self._insert("away", 1010.0, 1020.0, motion=3, motion_heatmap={"255": 9})
        self._insert("hit", 1020.0, 1030.0, motion=3, motion_heatmap={"0": 9})
        # The 0.1 x 0.1 ROI of a 40x20 VOD crops to 4x2 frames.
        small = np.zeros((2, 4), dtype=np.uint8)
        self.iter_frames.return_value = iter([small, small, small])
        polygon = [[0.0, 0.0], [0.1, 0.0], [0.1, 0.1], [0.0, 0.1]]

        runner = self._runner(polygon=polygon)
        runner.run()

        self.assertEqual(runner.metrics.metadata_inactive_segments, 1)
        self.assertEqual(runner.metrics.heatmap_roi_skip_segments, 1)
        self.assertEqual(runner.metrics.fallback_full_range_segments, 0)
        # Two gate skips plus the one decoded segment.
        self.assertEqual(runner.metrics.segments_processed, 3)
        self.assertIn("/start/1020/end/1030/", self.iter_frames.call_args.args[1])
        self.assertEqual(runner.scaled, (4, 2))
        self.assertEqual(runner.metrics.segments_with_errors, 0)

    def test_all_filtered_falls_back_to_full_scan(self):
        self._insert("idle1", 1000.0, 1010.0, motion=0, objects=0, regions=0)
        self._insert("idle2", 1010.0, 1020.0, motion=0, objects=0, regions=0)
        self.iter_frames.return_value = iter([_black(), _black(), _black()])

        runner = self._runner()
        runner.run()

        self.assertEqual(runner.metrics.fallback_full_range_segments, 2)
        self.assertIn("/start/1000/end/1020/", self.iter_frames.call_args.args[1])

    def test_unprobeable_vod_fails_job(self):
        self._insert("a", 1000.0, 1010.0)
        self.probe_dims.return_value = None
        runner = self._runner()
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.failed)
        self.assertEqual(
            runner.job.error_message, "Could not probe VOD dimensions for camera front"
        )

    def test_empty_runs_short_circuit(self):
        self._insert("a", 1000.0, 1010.0)
        with patch.object(ms, "coalesce_runs", return_value=[]):
            runner = self._runner()
            runner.run()
        self.assertEqual(runner.job.results["results"], [])
        self.probe_dims.assert_not_called()

    def test_cancel_before_search_marks_cancelled(self):
        self._insert("a", 1000.0, 1010.0)
        runner = self._runner()
        runner.cancel_event.set()
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.cancelled)
        self.iter_frames.assert_not_called()
        self.assertEqual(
            runner.job.results, {"results": [], "total_frames_processed": 0}
        )

    def test_decode_args_are_passed_to_decoder(self):
        self._insert("a", 1000.0, 1010.0)
        self.decode_args.return_value = ["-hwaccel", "vaapi"]
        self.iter_frames.return_value = iter([_black(), _black(), _black()])
        runner = self._runner(config=_config(internal="0.0.0.0:5055"))
        runner.run()
        self.assertEqual(self.iter_frames.call_args.args[5], ["-hwaccel", "vaapi"])
        self.assertIn("127.0.0.1:5055", self.iter_frames.call_args.args[1])


class TestSearchRuns(RunnerTestCase):
    def _runs(self, count: int) -> list[list[SimpleNamespace]]:
        # Non-contiguous single-segment runs, 100 s apart.
        return [
            [SimpleNamespace(start_time=1000.0 + i * 100, end_time=1010.0 + i * 100)]
            for i in range(count)
        ]

    def _process_by_start(self, outputs: dict[float, Any]) -> Any:
        def _process(run):
            value = outputs[run[0].start_time]
            if isinstance(value, Exception):
                raise value
            return value

        return _process

    def test_sequential_error_counts_and_continues(self):
        runner = self._runner()
        runs = self._runs(3)
        hit = MotionSearchResult(timestamp=1201.0, change_percentage=3.0)
        runner._process_run = MagicMock(
            side_effect=self._process_by_start(
                {1000.0: ([], 2), 1100.0: RuntimeError("boom"), 1200.0: ([hit], 4)}
            )
        )

        results = runner._search_runs(runs)

        self.assertEqual(results, [hit])
        self.assertEqual(runner.metrics.segments_with_errors, 1)
        self.assertEqual(runner.metrics.segments_processed, 3)
        self.assertEqual(runner.job.total_frames_processed, 6)
        self.assertEqual(runner.job.progress, 1.0)

    def test_sequential_stops_at_max_results(self):
        runner = self._runner(max_results=1)
        runs = self._runs(3)
        hit = MotionSearchResult(timestamp=1001.0, change_percentage=3.0)
        runner._process_run = MagicMock(return_value=([hit], 1))

        results = runner._search_runs(runs)

        self.assertEqual(results, [hit])
        self.assertEqual(runner._process_run.call_count, 1)

    def test_parallel_merges_in_order_and_counts_errors(self):
        runner = self._runner(parallel=True)
        runs = self._runs(3)
        hits = {
            1000.0: ([MotionSearchResult(1005.0, 2.0)], 3),
            1100.0: ValueError("bad run"),
            1200.0: ([MotionSearchResult(1205.0, 4.0)], 5),
        }
        runner._process_run = MagicMock(side_effect=self._process_by_start(hits))

        results = runner._search_runs(runs)

        self.assertEqual([r.timestamp for r in results], [1005.0, 1205.0])
        self.assertEqual(runner.metrics.segments_with_errors, 1)
        self.assertEqual(runner.metrics.segments_processed, 3)
        self.assertEqual(runner.job.total_frames_processed, 8)
        self.assertEqual(runner._process_run.call_count, 3)

    def test_parallel_stops_once_max_results_reached(self):
        runner = self._runner(parallel=True, max_results=1)
        runs = self._runs(4)
        runner._process_run = MagicMock(
            side_effect=lambda run: (
                [MotionSearchResult(run[0].start_time + 1, 9.0)],
                1,
            )
        )

        results = runner._search_runs(runs)

        self.assertEqual([r.timestamp for r in results], [1001.0])
        self.assertTrue(runner.internal_stop_event.is_set())
        self.assertTrue(runner._should_stop())
        self.assertEqual(runner.job.results["results"][0]["timestamp"], 1001.0)

    def test_parallel_cancelled_before_submit(self):
        runner = self._runner(parallel=True)
        runner.cancel_event.set()
        runner._process_run = MagicMock()
        self.assertEqual(runner._search_runs(self._runs(2)), [])
        runner._process_run.assert_not_called()

    def test_parallel_cancelled_while_collecting(self):
        runner = self._runner(parallel=True)

        runner._process_run = MagicMock(
            side_effect=lambda run: ([MotionSearchResult(run[0].start_time, 1.0)], 1)
        )
        with patch.object(runner, "_should_stop", side_effect=[False, False, True]):
            results = runner._search_runs(self._runs(2))
        self.assertEqual(results, [])
        self.assertEqual(runner.job.total_frames_processed, 0)


class TestRunnerInternals(RunnerTestCase):
    def test_deduplicate_results(self):
        runner = self._runner()
        self.assertEqual(runner._deduplicate_results([]), [])
        items = [
            MotionSearchResult(10.0, 1.0),
            MotionSearchResult(10.5, 1.0),
            MotionSearchResult(11.0, 1.0),
            MotionSearchResult(13.0, 1.0),
        ]
        self.assertEqual(
            [r.timestamp for r in runner._deduplicate_results(items)],
            [10.0, 11.0, 13.0],
        )
        self.assertEqual(
            [r.timestamp for r in runner._deduplicate_results(items, min_gap=2.5)],
            [10.0, 13.0],
        )

    def test_emit_progress_is_throttled(self):
        runner = self._runner()
        clock = MagicMock()
        clock.monotonic.side_effect = [100.0, 100.5, 101.2]
        with patch.object(ms, "time", clock):
            runner._emit_progress(1.0)
            runner._emit_progress(2.0)
            runner._emit_progress(3.0)
        cursors = [p["scanning_timestamp"] for p in self._sent_payloads()]
        self.assertEqual(cursors, [1.0, 3.0])
        self.assertEqual(runner.job.scanning_timestamp, 3.0)

    def test_detect_with_progress_skips_progress_when_stopping(self):
        runner = self._runner()
        runner.scaled_mask = np.full((VOD_H, VOD_W), 255, dtype=np.uint8)
        runner.internal_stop_event.set()
        results = runner._detect_with_progress(
            [(0, _black()), (1, _white())], lambda i: 500.0 + i
        )
        self.assertEqual([r.timestamp for r in results], [501.0])
        self.requestor.send_data.assert_not_called()

    def test_broadcast_failure_is_logged_not_raised(self):
        runner = self._runner()
        self.requestor.send_data.side_effect = RuntimeError("ipc down")
        runner.job.status = JobStatusTypesEnum.running
        runner.job.start_time = 1.0
        with self.assertLogs(ms.logger, level=logging.WARNING) as logs:
            runner._broadcast_status()
        self.assertIn("ipc down", logs.output[0])
        self.assertGreater(runner.metrics.wall_time_seconds, 0)

    def test_worker_cap(self):
        with patch.object(ms.os, "cpu_count", return_value=None):
            self.assertEqual(self._runner().max_workers, 1)
        with patch.object(ms.os, "cpu_count", return_value=16):
            self.assertEqual(self._runner().max_workers, 4)


class TestJobRegistry(unittest.TestCase):
    def setUp(self):
        ms._motion_search_jobs.clear()
        self.addCleanup(ms._motion_search_jobs.clear)
        job_manager._current_jobs.pop("motion_search", None)
        self.addCleanup(job_manager._current_jobs.pop, "motion_search", None)

    def test_start_registers_job_and_starts_runner(self):
        with patch.object(ms, "MotionSearchRunner") as runner_cls:
            job_id = start_motion_search_job(
                _config(),
                "front",
                1.0,
                2.0,
                FULL_POLYGON,
                threshold=12,
                min_area=2.5,
                parallel=True,
                max_results=3,
            )
        job, cancel_event = ms._motion_search_jobs[job_id]
        self.assertEqual(job.camera, "front")
        self.assertEqual((job.threshold, job.min_area, job.max_results), (12, 2.5, 3))
        self.assertTrue(job.parallel)
        runner_cls.assert_called_once()
        self.assertIs(runner_cls.call_args.args[2], cancel_event)
        runner_cls.return_value.start.assert_called_once()
        self.assertIs(job_manager.get_current_job("motion_search"), job)
        self.assertIs(get_motion_search_job(job_id), job)

    def test_get_falls_back_to_manager_and_none(self):
        job = MotionSearchJob(camera="front")
        job_manager.set_current_job(job)
        self.assertIs(get_motion_search_job(job.id), job)
        self.assertIsNone(get_motion_search_job("nope"))

    def test_cancel_unknown_and_finished_jobs(self):
        self.assertFalse(cancel_motion_search_job("nope"))
        job = MotionSearchJob(status=JobStatusTypesEnum.success)
        event = threading.Event()
        ms._motion_search_jobs[job.id] = (job, event)
        self.assertTrue(cancel_motion_search_job(job.id))
        self.assertFalse(event.is_set())
        self.assertEqual(job.status, JobStatusTypesEnum.success)

    def test_cancel_running_job_broadcasts(self):
        job = MotionSearchJob(status=JobStatusTypesEnum.running)
        event = threading.Event()
        ms._motion_search_jobs[job.id] = (job, event)
        requestor = MagicMock()
        with patch.object(ms, "InterProcessRequestor", return_value=requestor):
            self.assertTrue(cancel_motion_search_job(job.id))
        self.assertTrue(event.is_set())
        self.assertEqual(job.status, JobStatusTypesEnum.cancelled)
        topic, payload = requestor.send_data.call_args.args
        self.assertEqual(topic, ms.UPDATE_JOB_STATE)
        self.assertEqual(payload["status"], JobStatusTypesEnum.cancelled)
        requestor.stop.assert_called_once()

    def test_cancel_broadcast_failure_still_cancels(self):
        job = MotionSearchJob(status=JobStatusTypesEnum.queued)
        ms._motion_search_jobs[job.id] = (job, threading.Event())
        with (
            patch.object(ms, "InterProcessRequestor", side_effect=OSError("no socket")),
            self.assertLogs(ms.logger, level=logging.WARNING) as logs,
        ):
            self.assertTrue(cancel_motion_search_job(job.id))
        self.assertEqual(job.status, JobStatusTypesEnum.cancelled)
        self.assertIn("no socket", logs.output[0])

    def test_stop_all_only_signals_active_jobs(self):
        running = MotionSearchJob(status=JobStatusTypesEnum.running)
        queued = MotionSearchJob(status=JobStatusTypesEnum.queued)
        done = MotionSearchJob(status=JobStatusTypesEnum.failed)
        events = {}
        for job in (running, queued, done):
            events[job.id] = threading.Event()
            ms._motion_search_jobs[job.id] = (job, events[job.id])

        stop_all_motion_search_jobs()

        self.assertTrue(events[running.id].is_set())
        self.assertTrue(events[queued.id].is_set())
        self.assertFalse(events[done.id].is_set())


if __name__ == "__main__":
    unittest.main()
