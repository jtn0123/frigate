"""Coverage for the recording exporter (fork D70).

Builds RecordingExporter with a real FrigateConfig, an in-memory database
holding Recordings, Previews, ReviewSegment and Export rows, temporary
clips, cache and export directories, and ffmpeg calls mocked out.
"""

import datetime
import os
import tempfile
import unittest
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from playhouse.sqlite_ext import SqliteExtDatabase

from frigate.config import FrigateConfig
from frigate.config.camera.record import ChaptersEnum
from frigate.models import Export, ExportCase, Previews, Recordings, ReviewSegment
from frigate.record import export as export_module
from frigate.record.export import (
    ExportStreamEnum,
    PlaybackSourceEnum,
    RecordingExporter,
    StreamRun,
    migrate_exports,
    validate_ffmpeg_args,
)
from frigate.util.time import is_current_hour

CAMERA = "front"
START = 1_700_000_000
MODELS = [ExportCase, Export, Previews, Recordings, ReviewSegment]

CONFIG = """
mqtt:
  enabled: False
%(ui)s
cameras:
  front:
    ffmpeg:
      inputs:
        - path: rtsp://10.0.0.1:554/video
          roles:
            - detect
            - record
    detect:
      width: 640
      height: 360
      fps: 5
    record:
      enabled: True
"""


def make_config(timezone: str | None = None) -> FrigateConfig:
    ui = f"ui:\n  timezone: {timezone}" if timezone else ""
    return FrigateConfig.parse_yaml(CONFIG % {"ui": ui})


class ExportTestCase(unittest.TestCase):
    """Temp dirs, an in-memory database and a real config."""

    config: FrigateConfig

    @classmethod
    def setUpClass(cls) -> None:
        cls.config = make_config()

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.clips = os.path.join(self.root, "clips")
        self.cache = os.path.join(self.root, "cache")
        self.exports = os.path.join(self.root, "exports")
        self.preview_frames = os.path.join(self.cache, "preview_frames")
        for path in (self.clips, self.cache, self.exports, self.preview_frames):
            os.makedirs(path)

        for name, value in (
            ("CLIPS_DIR", self.clips),
            ("CACHE_DIR", self.cache),
            ("EXPORT_DIR", self.exports),
        ):
            patcher = patch.object(export_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.db = SqliteExtDatabase(":memory:")
        self.db.bind(MODELS)
        self.db.create_tables(MODELS)
        self.addCleanup(self.db.close)

    def exporter(self, **kwargs: Any) -> RecordingExporter:
        values: dict[str, Any] = {
            "config": self.config,
            "id": f"{CAMERA}_abc123",
            "camera": CAMERA,
            "name": None,
            "image": None,
            "start_time": START,
            "end_time": START + 60,
            "playback_source": PlaybackSourceEnum.recordings,
        }
        values.update(kwargs)
        return RecordingExporter(**values)

    def add_recording(
        self, id: str, start: float, end: float, stream_type: str = "main"
    ) -> None:
        Recordings.create(
            id=id,
            camera=CAMERA,
            path=f"/media/{id}.mp4",
            start_time=start,
            end_time=end,
            duration=end - start,
            stream_type=stream_type,
            video_codec="h264",
            audio_codec=None,
            audio_rate=None,
            has_audio=False,
            segment_size=0,
            keyframes=None,
        )

    def add_preview(self, id: str, start: float, end: float) -> None:
        Previews.create(
            id=id,
            camera=CAMERA,
            path=f"/media/preview/{id}.mp4",
            start_time=start,
            end_time=end,
            duration=end - start,
        )

    def add_review(
        self,
        id: str,
        start: float | None,
        end: float | None,
        severity: str = "alert",
        data: dict | None = None,
    ) -> None:
        ReviewSegment.create(
            id=id,
            camera=CAMERA,
            start_time=start,
            end_time=end,
            severity=severity,
            thumb_path=f"/thumbs/{id}.webp",
            data=data if data is not None else {"objects": ["person"]},
        )

    def write_frame(self, frame_time: float, camera: str = CAMERA) -> str:
        path = os.path.join(self.preview_frames, f"preview_{camera}-{frame_time}.webp")
        with open(path, "wb") as f:
            f.write(f"{camera}-{frame_time}".encode())
        return path


class TestValidateFfmpegArgsEdges(unittest.TestCase):
    def test_empty_filter_specs_are_skipped(self) -> None:
        self.assertEqual(validate_ffmpeg_args("-vf scale=320:-1,,fps=5"), (True, ""))

    def test_missing_value_is_rejected(self) -> None:
        valid, message = validate_ffmpeg_args("-an -crf")
        self.assertFalse(valid)
        self.assertIn("Missing value", message)

    def test_unsafe_value_is_rejected(self) -> None:
        valid, message = validate_ffmpeg_args("-preset ../etc")
        self.assertFalse(valid)
        self.assertIn("Invalid value for -preset", message)


class TestInitAndProgress(ExportTestCase):
    def test_init_creates_thumb_dir_and_stores_options(self) -> None:
        exporter = self.exporter(
            name="Porch",
            export_case_id="case1",
            ffmpeg_input_args="-an",
            ffmpeg_output_args="-r 30",
            cpu_fallback=True,
            chapters=ChaptersEnum.review_items,
            stream=ExportStreamEnum.sub,
        )

        self.assertTrue(os.path.isdir(os.path.join(self.clips, "export")))
        self.assertEqual(exporter.user_provided_name, "Porch")
        self.assertEqual(exporter.export_case_id, "case1")
        self.assertTrue(exporter.cpu_fallback)
        self.assertEqual(exporter.pinned_stream, "sub")
        self.assertEqual(exporter.staged_runs, [])

    def test_progress_is_clamped_and_failures_are_logged(self) -> None:
        calls: list[tuple[str, float]] = []
        exporter = self.exporter(on_progress=lambda s, p: calls.append((s, p)))

        exporter._emit_progress("copying", 150.0)
        exporter._emit_progress("copying", -5.0)
        self.assertEqual(calls, [("copying", 100.0), ("copying", 0.0)])

        exporter.on_progress = MagicMock(side_effect=RuntimeError("boom"))
        with self.assertLogs(export_module.logger, "ERROR") as logs:
            exporter._emit_progress("copying", 50.0)
        self.assertIn("progress callback failed", logs.output[0])

    def test_progress_without_callback_is_a_noop(self) -> None:
        self.exporter()._emit_progress("copying", 10.0)

    def test_staged_progress_maps_into_its_slice(self) -> None:
        calls: list[tuple[str, float]] = []
        exporter = self.exporter(on_progress=lambda s, p: calls.append((s, p)))

        report = exporter._staged_progress("copying", 25.0, 50.0)
        report(50.0)

        self.assertEqual(calls, [("copying", 50.0)])

    def test_internal_port_accepts_host_and_port(self) -> None:
        exporter = self.exporter()
        self.assertEqual(exporter._internal_port(), 5000)

        exporter.config = MagicMock()
        exporter.config.networking.listen.internal = "127.0.0.1:5011"
        self.assertEqual(exporter._internal_port(), 5011)
        self.assertEqual(
            exporter._vod_url(None, 1.0, 2.0),
            "http://127.0.0.1:5011/vod/front/start/1.0/end/2.0/index.m3u8",
        )


class TestProbeAndStaging(ExportTestCase):
    def run_of(self, stream: str, start: float, end: float) -> StreamRun:
        return StreamRun(stream, start, end, f"/media/{stream}.mp4")

    def test_probe_reads_width_and_height(self) -> None:
        exporter = self.exporter()
        probe = AsyncMock(return_value={"width": 1920, "height": 1080})

        with patch.object(export_module, "get_video_properties", probe):
            size = exporter._probe_stream_resolution(self.run_of("main", 0, 10))

        self.assertEqual(size, (1920, 1080))
        self.assertEqual(probe.call_args.args[1], "/media/main.mp4")

    def test_probe_without_dimensions_is_none(self) -> None:
        exporter = self.exporter()
        probe = AsyncMock(return_value={"width": 0})

        with patch.object(export_module, "get_video_properties", probe):
            self.assertIsNone(
                exporter._probe_stream_resolution(self.run_of("sub", 0, 10))
            )

    def test_probe_os_error_is_none(self) -> None:
        exporter = self.exporter()
        probe = AsyncMock(side_effect=OSError("gone"))

        with (
            patch.object(export_module, "get_video_properties", probe),
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            self.assertIsNone(
                exporter._probe_stream_resolution(self.run_of("sub", 0, 10))
            )

    def test_mixed_codecs_are_reencoded_to_the_largest_size(self) -> None:
        calls: list[tuple[str, float]] = []
        exporter = self.exporter(on_progress=lambda s, p: calls.append((s, p)))
        runs = [self.run_of("main", 0, 30), self.run_of("sub", 30, 40)]
        sizes = {"/media/main.mp4": (1920, 1080), "/media/sub.mp4": (640, 480)}

        def fake_ffmpeg(cmd: list[str], **kwargs: Any) -> tuple[int, str]:
            kwargs["on_progress"](100.0)
            return 0, ""

        with (
            patch.object(
                RecordingExporter,
                "_probe_stream_resolution",
                side_effect=lambda run: sizes[run.sample_path],
            ),
            patch.object(
                export_module, "run_ffmpeg_with_progress", side_effect=fake_ffmpeg
            ) as ffmpeg,
        ):
            ok = exporter._stage_stream_runs(runs, {"h264", "hevc"}, False)

        self.assertTrue(ok)
        self.assertEqual(len(exporter.staged_runs), 2)
        first_cmd = " ".join(ffmpeg.call_args_list[0].args[0])
        self.assertIn("scale=1920:1080:force_original_aspect_ratio=decrease", first_cmd)
        self.assertIn("-an", first_cmd)
        self.assertEqual(
            ffmpeg.call_args_list[1].kwargs["expected_duration_seconds"], 10
        )
        # each run reports into its share of the whole pass
        self.assertEqual(calls, [("encoding", 75.0), ("encoding", 100.0)])

    def test_mixed_codecs_without_any_probe_abort(self) -> None:
        exporter = self.exporter()

        with (
            patch.object(
                RecordingExporter, "_probe_stream_resolution", return_value=None
            ),
            patch.object(export_module, "run_ffmpeg_with_progress") as ffmpeg,
            self.assertLogs(export_module.logger, "ERROR") as logs,
        ):
            ok = exporter._stage_stream_runs(
                [self.run_of("main", 0, 10), self.run_of("sub", 10, 20)],
                {"h264", "hevc"},
                True,
            )

        self.assertFalse(ok)
        ffmpeg.assert_not_called()
        self.assertIn("no run could be probed", logs.output[0])


class TestSourceDuration(ExportTestCase):
    def test_previews_are_clipped_to_the_range(self) -> None:
        self.add_preview("before", START - 30, START + 10)
        self.add_preview("inside", START + 20, START + 30)
        self.add_preview("after", START + 50, START + 90)
        self.add_preview("elsewhere", START + 500, START + 600)
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)

        self.assertEqual(exporter._sum_source_duration_seconds(), 30.0)

    def test_preview_query_failure_is_none(self) -> None:
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)

        with (
            patch.object(Previews, "select", side_effect=RuntimeError("db")),
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            self.assertIsNone(exporter._sum_source_duration_seconds())

    def test_bad_preview_row_is_none(self) -> None:
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)
        query = MagicMock()
        query.where.return_value = query
        query.iterator.return_value = iter([MagicMock(start_time=None, end_time=1)])

        with (
            patch.object(Previews, "select", return_value=query),
            self.assertLogs(export_module.logger, "ERROR") as logs,
        ):
            self.assertIsNone(exporter._sum_source_duration_seconds())

        self.assertIn("Failed to read recording rows", logs.output[0])

    def test_recordings_sum_the_merged_timeline(self) -> None:
        self.add_recording("r1", START, START + 10)
        self.add_recording("r2", START + 20, START + 40)

        self.assertEqual(self.exporter()._sum_source_duration_seconds(), 30.0)

    def test_run_ffmpeg_joins_playlist_lines(self) -> None:
        calls: list[tuple[str, float]] = []
        exporter = self.exporter(on_progress=lambda s, p: calls.append((s, p)))
        exporter._coverage = ([], set(), False)

        def fake_ffmpeg(cmd: list[str], **kwargs: Any) -> tuple[int, str]:
            kwargs["on_progress"](40.0)
            return 0, kwargs["stdin_payload"]

        with patch.object(
            export_module, "run_ffmpeg_with_progress", side_effect=fake_ffmpeg
        ) as ffmpeg:
            self.assertEqual(
                exporter._run_ffmpeg_with_progress(["ffmpeg"], ["a", "b"], "merging"),
                (0, "a\nb"),
            )
            self.assertEqual(
                exporter._run_ffmpeg_with_progress(["ffmpeg"], "raw"), (0, "raw")
            )

        self.assertEqual(ffmpeg.call_args.kwargs["expected_duration_seconds"], 60.0)
        self.assertEqual(calls, [("merging", 40.0), ("encoding", 40.0)])


class TestReviewChapters(ExportTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.ex = self.exporter(end_time=START + 100)
        self.recordings = [
            MagicMock(start_time=START, end_time=START + 30),
            MagicMock(start_time=START + 50, end_time=START + 80),
        ]

    def chapters(self) -> str:
        path = self.ex._build_chapter_metadata_file(self.recordings)
        self.assertEqual(path, self.ex._chapter_metadata_path())
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_no_usable_recordings(self) -> None:
        self.assertIsNone(self.ex._build_chapter_metadata_file([]))
        self.assertIsNone(
            self.ex._build_chapter_metadata_file(
                [MagicMock(start_time=START - 20, end_time=START - 10)]
            )
        )

    def test_no_review_rows(self) -> None:
        self.add_review("other_time", START + 500, START + 600)

        self.assertIsNone(self.ex._build_chapter_metadata_file(self.recordings))

    def test_review_query_failure(self) -> None:
        with (
            patch.object(ReviewSegment, "select", side_effect=RuntimeError("db")),
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            self.assertIsNone(self.ex._build_chapter_metadata_file(self.recordings))

    def test_chapters_map_wall_time_to_output_time(self) -> None:
        # starts inside the recording gap, so it snaps to the second window
        self.add_review(
            "gap_start",
            START + 40,
            START + 60,
            data={"objects": ["person-verified", "car", "person"]},
        )
        # ends after the last recording, so it runs to the end of output
        self.add_review(
            "tail",
            START + 70,
            START + 95,
            severity="detection",
            data={"metadata": {"title": "Delivery"}},
        )
        # falls entirely inside the gap, so it has no output duration
        self.add_review("in_gap", START + 32, START + 45)

        content = self.chapters()

        self.assertTrue(content.startswith(";FFMETADATA1\n"))
        self.assertEqual(content.count("[CHAPTER]"), 2)
        self.assertIn("START=30000\nEND=40000\ntitle=Alert: person, car", content)
        self.assertIn("START=50000\nEND=60000\ntitle=Delivery", content)

    def test_review_without_labels_uses_severity(self) -> None:
        self.add_review("plain", START + 5, START + 10, severity="detection", data={})

        self.assertIn("title=Detection\n", self.chapters())

    def test_rows_without_start_are_skipped(self) -> None:
        rows = [MagicMock(start_time=None, end_time=START + 10)]
        query = MagicMock()
        query.where.return_value = query
        query.order_by.return_value = query
        query.iterator.return_value = iter(rows)

        with patch.object(ReviewSegment, "select", return_value=query):
            self.assertIsNone(self.ex._build_chapter_metadata_file(self.recordings))

    def test_write_failure_is_none(self) -> None:
        self.add_review("r", START + 5, START + 20)
        self.ex._chapter_metadata_path = lambda: os.path.join(  # type: ignore[method-assign]
            self.root, "missing", "chapters.txt"
        )

        with self.assertLogs(export_module.logger, "ERROR"):
            self.assertIsNone(self.ex._build_chapter_metadata_file(self.recordings))


class TestRecordingSegmentChapters(ExportTestCase):
    def test_empty_inputs(self) -> None:
        exporter = self.exporter()

        self.assertIsNone(exporter._build_recording_segment_chapter_metadata_file([]))
        self.assertIsNone(
            exporter._build_recording_segment_chapter_metadata_file(
                [
                    MagicMock(start_time=START - 20, end_time=START - 10),
                    # a sliver that rounds to zero milliseconds
                    MagicMock(start_time=START + 1, end_time=START + 1.0001),
                ]
            )
        )

    def test_titles_use_configured_timezone(self) -> None:
        exporter = self.exporter()
        exporter.config = make_config("America/New_York")

        path = exporter._build_recording_segment_chapter_metadata_file(
            [
                MagicMock(start_time=START - 5, end_time=START + 10),
                MagicMock(start_time=START + 20, end_time=START + 25),
            ]
        )

        with open(path, encoding="utf-8") as f:
            content = f.read()

        first = datetime.datetime.fromtimestamp(
            START, tz=datetime.timezone(datetime.timedelta(hours=-5))
        ).isoformat(timespec="seconds")
        self.assertIn(f"START=0\nEND=10000\ntitle={first}", content)
        self.assertIn("START=10000\nEND=15000\n", content)

    def test_invalid_timezone_falls_back_to_utc(self) -> None:
        exporter = self.exporter()
        exporter.config = MagicMock()
        exporter.config.ui.timezone = "Not/AZone"

        path = exporter._build_recording_segment_chapter_metadata_file(
            [MagicMock(start_time=START, end_time=START + 10)]
        )

        with open(path, encoding="utf-8") as f:
            self.assertIn("title=2023-11-14T22:13:20+00:00", f.read())

    def test_write_failure_is_none(self) -> None:
        exporter = self.exporter()
        exporter._chapter_metadata_path = lambda: os.path.join(  # type: ignore[method-assign]
            self.root, "missing", "chapters.txt"
        )

        with self.assertLogs(export_module.logger, "ERROR"):
            self.assertIsNone(
                exporter._build_recording_segment_chapter_metadata_file(
                    [MagicMock(start_time=START, end_time=START + 10)]
                )
            )


class TestSaveThumbnail(ExportTestCase):
    def test_user_image_is_copied(self) -> None:
        image = os.path.join(self.root, "mine.webp")
        with open(image, "wb") as f:
            f.write(b"user-image")
        exporter = self.exporter(image=image)

        path = exporter.save_thumbnail("e1")

        self.assertEqual(path, os.path.join(self.clips, "export/e1.webp"))
        with open(path, "rb") as f:
            self.assertEqual(f.read(), b"user-image")

    def test_past_export_extracts_from_preview(self) -> None:
        self.add_preview("p1", START - 15.5, START + 100)
        exporter = self.exporter()

        with patch.object(
            export_module.sp, "run", return_value=MagicMock(returncode=0)
        ) as run:
            path = exporter.save_thumbnail("e1")

        self.assertEqual(path, os.path.join(self.clips, "export/e1.webp"))
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[cmd.index("-ss") + 1], "15.500")
        self.assertEqual(cmd[cmd.index("-i") + 1], "/media/preview/p1.mp4")
        self.assertEqual(cmd[-1], path)

    def test_past_export_ffmpeg_failure(self) -> None:
        self.add_preview("p1", START, START + 100)

        with (
            patch.object(
                export_module.sp,
                "run",
                return_value=MagicMock(returncode=1, stderr=b"bad"),
            ),
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            self.assertEqual(self.exporter().save_thumbnail("e1"), "")

    def test_past_export_without_preview(self) -> None:
        with patch.object(export_module.sp, "run") as run:
            self.assertEqual(self.exporter().save_thumbnail("e1"), "")

        run.assert_not_called()

    def test_current_hour_skips_other_cameras_and_later_frames(self) -> None:
        now = int(datetime.datetime.now(datetime.UTC).timestamp())
        # another camera's frame sorts first and must be skipped
        self.write_frame(now + 1, camera="back")
        self.write_frame(now + 100)
        exporter = self.exporter(start_time=now, end_time=now + 5)

        self.assertEqual(exporter.save_thumbnail("e1"), "")


class TestRecordExportCommand(ExportTestCase):
    def test_pinned_stream_copy_with_metadata(self) -> None:
        self.add_recording("m1", START, START + 30)
        exporter = self.exporter(stream=ExportStreamEnum.main)

        cmd, playlist = exporter.get_record_export_command("/out.mp4")

        self.assertEqual(playlist, [])
        self.assertEqual(cmd[0], self.config.ffmpeg.ffmpeg_path)
        self.assertIn(
            f"http://127.0.0.1:5000/vod/front/main/start/{START}/end/{START + 60}"
            "/index.m3u8",
            cmd,
        )
        self.assertIn("copy", cmd)
        self.assertEqual(cmd[-1], "/out.mp4")
        self.assertIn("comment=Camera: front", cmd)
        self.assertIn("creation_time=2023-11-14T22:13:20.000000Z", cmd)

    def test_custom_args_encode_with_and_without_hwaccel(self) -> None:
        exporter = self.exporter(
            stream=ExportStreamEnum.main,
            ffmpeg_input_args="-an",
            ffmpeg_output_args="-vf setpts=0.04*PTS -r 30",
        )

        with patch.object(
            export_module,
            "parse_preset_hardware_acceleration_encode",
            return_value="ffmpeg -i x -c:v libx264",
        ) as encode:
            cmd, _ = exporter.get_record_export_command("/out.mp4")
            exporter.get_record_export_command("/out.mp4", use_hwaccel=False)

        first, second = encode.call_args_list
        self.assertEqual(
            first.args[1], self.config.cameras[CAMERA].record.export.hwaccel_args
        )
        self.assertIsNone(second.args[1])
        self.assertTrue(first.args[2].startswith("-an -y -protocol_whitelist"))
        self.assertEqual(
            first.args[3], "-vf setpts=0.04*PTS -r 30 -movflags +faststart"
        )
        self.assertEqual(cmd[:4], ["ffmpeg", "-i", "x", "-c:v"])
        self.assertEqual(cmd[-1], "/out.mp4")

    def test_recording_segment_chapters_are_attached(self) -> None:
        self.add_recording("m1", START, START + 30)
        exporter = self.exporter(
            stream=ExportStreamEnum.main, chapters=ChaptersEnum.recording_segments
        )

        cmd, _ = exporter.get_record_export_command("/out.mp4")

        chapters = exporter._chapter_metadata_path()
        self.assertTrue(os.path.isfile(chapters))
        self.assertEqual(cmd[cmd.index(chapters) - 1], "-i")
        self.assertIn("-map_metadata", cmd)

    def test_timezone_names_the_title(self) -> None:
        exporter = self.exporter(stream=ExportStreamEnum.main)
        exporter.config = make_config("UTC")

        cmd, _ = exporter.get_record_export_command("/out.mp4")

        self.assertIn(
            "title=Frigate Recording for front, 2023-11-14 22:13:20 - "
            "2023-11-14 22:14:20",
            cmd,
        )


class TestIsCurrentHour(unittest.TestCase):
    def test_only_the_current_utc_hour_matches(self) -> None:
        # B24: any past timestamp used to count as the current hour
        now = datetime.datetime.now(datetime.UTC).timestamp()

        self.assertTrue(is_current_hour(int(now)))
        self.assertFalse(is_current_hour(START))
        self.assertFalse(is_current_hour(int(now) - 2 * 3600))
        self.assertFalse(is_current_hour(int(now) + 2 * 3600))


class TestPreviewExportCommand(ExportTestCase):
    def test_previews_are_trimmed_with_in_and_out_points(self) -> None:
        self.add_preview("a", START - 10, START + 30)
        self.add_preview("b", START + 30, START + 75)
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)

        cmd, playlist = exporter.get_preview_export_command("/out.mp4")

        # in and out points are offsets from the start of each file (B24)
        self.assertEqual(
            playlist,
            [
                "file '/media/preview/a.mp4'",
                "inpoint 10",
                "file '/media/preview/b.mp4'",
                "outpoint 30",
            ],
        )
        joined = " ".join(cmd)
        self.assertIn("-f concat -safe 0 -i /dev/stdin -c copy", joined)
        self.assertIn("title=Frigate Preview for front", joined)
        self.assertEqual(cmd[-1], "/out.mp4")

    def test_one_preview_spanning_the_export_keeps_its_length(self) -> None:
        # B24: [S - 10, S + 100] exported as [S, S + 60] plays 10 to 70, which is
        # 60 seconds; the old out point of 40 cut it to 30
        self.add_preview("a", START - 10, START + 100)
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)

        _, playlist = exporter.get_preview_export_command("/out.mp4")

        self.assertEqual(
            playlist,
            ["file '/media/preview/a.mp4'", "inpoint 10", "outpoint 70"],
        )

    def test_past_hour_does_not_read_cached_frames(self) -> None:
        # B24: is_current_hour was true for every past time, so a past export
        # listed the frame cache and failed when it was missing
        os.rmdir(self.preview_frames)
        self.add_preview("a", START, START + 60)
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)

        cmd, playlist = exporter.get_preview_export_command("/out.mp4")

        self.assertEqual(playlist, ["file '/media/preview/a.mp4'"])
        self.assertIn("-c copy", " ".join(cmd))

    def test_current_hour_frames_are_encoded(self) -> None:
        now = int(datetime.datetime.now(datetime.UTC).timestamp())
        early = self.write_frame(now - 10)
        first = self.write_frame(now + 1)
        second = self.write_frame(now + 2)
        self.write_frame(now + 50)
        self.write_frame(now + 1, camera="back")
        exporter = self.exporter(
            playback_source=PlaybackSourceEnum.preview,
            start_time=now,
            end_time=now + 5,
        )

        cmd, playlist = exporter.get_preview_export_command("/out.mp4")

        self.assertEqual(
            playlist,
            [
                f"file '{first}'",
                "duration 0.12",
                f"file '{second}'",
                "duration 0.12",
                f"file '{second}'",
            ],
        )
        self.assertNotIn(f"file '{early}'", playlist)
        self.assertIn("libx264", cmd)

    def test_custom_args_skip_non_keyframes(self) -> None:
        exporter = self.exporter(
            playback_source=PlaybackSourceEnum.preview,
            ffmpeg_input_args="-an",
            ffmpeg_output_args="-r 30",
        )

        with patch.object(
            export_module,
            "parse_preset_hardware_acceleration_encode",
            return_value="ffmpeg -i x",
        ) as encode:
            exporter.get_preview_export_command("/out.mp4")
            exporter.get_preview_export_command("/out.mp4", use_hwaccel=False)

        first, second = encode.call_args_list
        self.assertTrue(first.args[2].startswith("-an -skip_frame nokey -y"))
        self.assertEqual(first.args[3], "-r 30 -movflags +faststart")
        self.assertIsNone(second.args[1])


class TestRun(ExportTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.thumb = patch.object(
            RecordingExporter, "save_thumbnail", return_value="/thumb.webp"
        )
        self.thumb.start()
        self.addCleanup(self.thumb.stop)

    def run_export(
        self, exporter: RecordingExporter, results: list[tuple[int, str]]
    ) -> MagicMock:
        with patch.object(
            export_module, "run_ffmpeg_with_progress", side_effect=results
        ) as ffmpeg:
            exporter.run()

        return ffmpeg

    def test_successful_recording_export(self) -> None:
        self.add_recording("m1", START, START + 60)
        calls: list[tuple[str, float]] = []
        exporter = self.exporter(on_progress=lambda s, p: calls.append((s, p)))

        ffmpeg = self.run_export(exporter, [(0, "")])

        export = Export.get(Export.id == exporter.export_id)
        self.assertFalse(export.in_progress)
        self.assertEqual(export.thumb_path, "/thumb.webp")
        self.assertTrue(export.name.startswith("front "))
        self.assertTrue(
            export.video_path.startswith(os.path.join(self.exports, "front_"))
        )
        self.assertTrue(export.video_path.endswith("_abc123.mp4"))
        self.assertEqual(ffmpeg.call_count, 1)
        self.assertEqual(calls[0], ("preparing", 0.0))
        self.assertEqual(calls[-1], ("finalizing", 100.0))

    def test_named_export_in_a_case(self) -> None:
        now = datetime.datetime.now()
        ExportCase.create(id="case1", name="Case", created_at=now, updated_at=now)
        self.add_preview("p", START, START + 60)
        exporter = self.exporter(
            name="Porch visit",
            export_case_id="case1",
            playback_source=PlaybackSourceEnum.preview,
        )

        self.run_export(exporter, [(0, "")])

        export = Export.get(Export.id == exporter.export_id)
        self.assertEqual(export.name, "Porch visit")
        self.assertEqual(export.export_case.id, "case1")
        self.assertEqual(
            export.video_path, os.path.join(self.exports, "Porch visit_abc123.mp4")
        )

    def test_failed_export_is_discarded(self) -> None:
        exporter = self.exporter(stream=ExportStreamEnum.main)
        video = os.path.join(self.exports, "partial.mp4")
        with open(video, "wb") as f:
            f.write(b"partial")
        thumb = os.path.join(self.root, "thumb.webp")
        with open(thumb, "wb") as f:
            f.write(b"thumb")
        Export.insert(
            {
                Export.id: exporter.export_id,
                Export.camera: CAMERA,
                Export.name: "x",
                Export.date: START,
                Export.video_path: video,
                Export.thumb_path: thumb,
                Export.in_progress: True,
            }
        ).execute()

        with (
            patch.object(
                export_module, "run_ffmpeg_with_progress", return_value=(1, "err")
            ),
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            exporter._run_export(video, thumb)

        self.assertFalse(os.path.exists(video))
        self.assertFalse(os.path.exists(thumb))
        self.assertEqual(Export.select().count(), 0)

    def test_cpu_fallback_retries_recordings_without_hwaccel(self) -> None:
        exporter = self.exporter(
            stream=ExportStreamEnum.main,
            ffmpeg_input_args="-an",
            ffmpeg_output_args="-r 30",
            cpu_fallback=True,
        )

        with (
            patch.object(
                RecordingExporter,
                "get_record_export_command",
                return_value=(["ffmpeg", "/out.mp4"], []),
            ) as command,
            self.assertLogs(export_module.logger, "WARNING"),
        ):
            ffmpeg = self.run_export(exporter, [(1, "hw"), (0, "")])

        self.assertEqual(command.call_args.kwargs, {"use_hwaccel": False})
        self.assertEqual(
            [c.kwargs.get("on_progress") is not None for c in ffmpeg.call_args_list],
            [True, True],
        )
        self.assertFalse(Export.get(Export.id == exporter.export_id).in_progress)

    def test_cpu_fallback_retries_previews_and_can_still_fail(self) -> None:
        steps: list[str] = []
        exporter = self.exporter(
            playback_source=PlaybackSourceEnum.preview,
            ffmpeg_input_args="-an",
            ffmpeg_output_args="-r 30",
            cpu_fallback=True,
            on_progress=lambda s, p: steps.append(s),
        )

        def fail(cmd: list[str], **kwargs: Any) -> tuple[int, str]:
            kwargs["on_progress"](10.0)
            return 1, "err"

        with (
            patch.object(
                RecordingExporter,
                "get_preview_export_command",
                return_value=(["ffmpeg", "/out.mp4"], []),
            ) as command,
            patch.object(export_module, "run_ffmpeg_with_progress", side_effect=fail),
            self.assertLogs(export_module.logger, "WARNING"),
        ):
            exporter.run()

        self.assertEqual(command.call_args.kwargs, {"use_hwaccel": False})
        self.assertEqual(steps, ["preparing", "encoding", "encoding_retry"])
        self.assertEqual(Export.select().count(), 0)

    def test_staging_failure_discards_export(self) -> None:
        exporter = self.exporter()

        with (
            patch.object(RecordingExporter, "_prepare_stream_runs", return_value=False),
            patch.object(export_module, "run_ffmpeg_with_progress") as ffmpeg,
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            exporter.run()

        ffmpeg.assert_not_called()
        self.assertEqual(Export.select().count(), 0)

    def test_staged_export_merges_and_cleans_up(self) -> None:
        steps: list[str] = []
        exporter = self.exporter(on_progress=lambda s, p: steps.append(s))
        staged = os.path.join(self.cache, "stage_0.mp4")

        def stage() -> bool:
            with open(staged, "wb") as f:
                f.write(b"run")
            exporter.staged_runs = [staged]
            exporter._coverage = ([], set(), False)
            return True

        def merge(cmd: list[str], **kwargs: Any) -> tuple[int, str]:
            kwargs["on_progress"](50.0)
            return 0, ""

        with (
            patch.object(exporter, "_prepare_stream_runs", side_effect=stage),
            patch.object(export_module, "run_ffmpeg_with_progress", side_effect=merge),
        ):
            exporter.run()

        self.assertIn("merging", steps)
        self.assertFalse(os.path.exists(staged))
        self.assertEqual(exporter.staged_runs, [])

    def test_missing_rows_leave_export_in_progress(self) -> None:
        exporter = self.exporter(playback_source=PlaybackSourceEnum.preview)

        with (
            patch.object(
                RecordingExporter,
                "get_preview_export_command",
                side_effect=export_module.DoesNotExist,
            ),
            patch.object(export_module, "run_ffmpeg_with_progress") as ffmpeg,
        ):
            exporter.run()

        ffmpeg.assert_not_called()
        self.assertTrue(Export.get(Export.id == exporter.export_id).in_progress)


class TestMigrateExports(ExportTestCase):
    def test_existing_files_become_export_rows(self) -> None:
        for name in ("front_old.mp4", "mystery.mp4", "broken_front.mp4"):
            with open(os.path.join(self.exports, name), "wb") as f:
                f.write(b"video")

        def fake_run(cmd: list[str], **kwargs: Any) -> MagicMock:
            ok = "broken" not in cmd[cmd.index("-i") + 1]
            return MagicMock(returncode=0 if ok else 1, stderr=b"bad")

        with (
            patch.object(export_module.sp, "run", side_effect=fake_run) as run,
            self.assertLogs(export_module.logger, "ERROR"),
        ):
            migrate_exports(self.config.ffmpeg, [CAMERA])

        self.assertEqual(run.call_count, 3)
        rows = {e.name: e for e in Export.select()}
        self.assertEqual(set(rows), {"front_old", "mystery"})
        self.assertEqual(rows["front_old"].camera, CAMERA)
        self.assertEqual(rows["mystery"].camera, "unknown")
        self.assertFalse(rows["front_old"].in_progress)
        self.assertTrue(rows["mystery"].thumb_path.endswith(".jpg"))
        self.assertTrue(os.path.isdir(os.path.join(self.clips, "export")))


if __name__ == "__main__":
    unittest.main()
