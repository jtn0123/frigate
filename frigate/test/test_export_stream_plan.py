"""The export's stream plan must match what the vod manifest serves."""

import json
import unittest
from unittest.mock import MagicMock, patch

from playhouse.sqlite_ext import SqliteExtDatabase

from frigate.api.media import _vod_response
from frigate.config.camera.record import ChaptersEnum
from frigate.const import MAX_PLAYLIST_SECONDS
from frigate.models import Recordings
from frigate.record.export import (
    ExportStreamEnum,
    PlaybackSourceEnum,
    RecordingExporter,
)

CAMERA = "front_door"


def _exporter(start: float, end: float) -> RecordingExporter:
    """An auto exporter that resolves coverage from the database."""
    exporter = RecordingExporter.__new__(RecordingExporter)
    exporter.config = MagicMock()
    exporter.config.ffmpeg.ffmpeg_path = "ffmpeg"
    exporter.config.networking.listen.internal = 5000
    exporter.export_id = "front_door_abc123"
    exporter.camera = CAMERA
    exporter.start_time = start
    exporter.end_time = end
    exporter.playback_source = PlaybackSourceEnum.recordings
    exporter.ffmpeg_input_args = None
    exporter.ffmpeg_output_args = None
    exporter.chapters = None
    exporter.stream = ExportStreamEnum.auto
    exporter.staged_runs = []
    exporter.staged_transcode = False
    exporter._coverage = None
    return exporter


class ExportPlanDbTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.db = SqliteExtDatabase(":memory:")
        self.db.bind([Recordings])
        self.db.create_tables([Recordings])

    def tearDown(self) -> None:
        self.db.close()

    def _insert(
        self, id: str, start: float, end: float, stream_type: str, has_audio: bool
    ) -> None:
        Recordings.create(
            id=id,
            camera=CAMERA,
            path=f"/tmp/{id}.mp4",
            start_time=start,
            end_time=end,
            duration=end - start,
            stream_type=stream_type,
            video_codec="h264",
            audio_codec="aac" if has_audio else None,
            audio_rate=16000 if has_audio else None,
            has_audio=has_audio,
            segment_size=0,
        )

    def _manifest(
        self, start: float, end: float, stream: str | None = None
    ) -> tuple[int, dict]:
        response = _vod_response(CAMERA, start, end, stream_preference=stream)
        return response.status_code, json.loads(response.body)

    def _staged_runs(self, exporter: RecordingExporter) -> list:
        """The runs the exporter hands to staging, or [] when unstaged."""
        with patch.object(
            RecordingExporter, "_stage_stream_runs", return_value=True
        ) as stage:
            self.assertTrue(exporter._prepare_stream_runs())

        return stage.call_args.args[0] if stage.called else []

    def _assert_plan_matches_manifest(
        self, exporter: RecordingExporter, start: float, end: float
    ) -> None:
        status, mapping = self._manifest(start, end)
        self.assertEqual(status, 200)
        served = [clip["path"] for clip in mapping["sequences"][0]["clips"]]
        planned = [row.path for row, _s, _e, _m in exporter._merged_spans()]
        self.assertEqual(planned, served)


class TestExportPlansTheServedTimeline(ExportPlanDbTestCase):
    def test_glitch_row_inside_main_is_staged_around(self) -> None:
        """A dropped main glitch row is filled from sub, so the range mixes."""
        self._insert("m1", 1000.0, 1010.0, "main", True)
        self._insert("m2", 1010.0, 1010.5, "main", False)
        self._insert("m3", 1010.5, 1020.0, "main", True)
        self._insert("s1", 1000.0, 1020.0, "sub", True)
        exporter = _exporter(1000.0, 1020.0)

        _status, mapping = self._manifest(1000.0, 1020.0)
        # the merged manifest really does hand off to sub mid-range
        self.assertTrue(mapping["discontinuity"])
        self._assert_plan_matches_manifest(exporter, 1000.0, 1020.0)

        runs = self._staged_runs(exporter)
        self.assertEqual([run.stream_type for run in runs], ["main", "sub", "main"])
        self.assertNotIn("/tmp/m2.mp4", [run.sample_path for run in runs])

    def test_isolated_glitch_row_is_not_its_own_run(self) -> None:
        """Every staged run must be one its pinned vod route can serve."""
        self._insert("m1", 1000.0, 1010.0, "main", True)
        self._insert("m2", 1020.0, 1020.5, "main", False)
        self._insert("s1", 1010.0, 1030.0, "sub", True)
        exporter = _exporter(1000.0, 1030.0)

        self._assert_plan_matches_manifest(exporter, 1000.0, 1030.0)

        runs = self._staged_runs(exporter)
        self.assertEqual([run.stream_type for run in runs], ["main", "sub"])
        for run in runs:
            status, _mapping = self._manifest(
                run.start_time, run.end_time, run.stream_type
            )
            self.assertEqual(status, 200, f"pinned run {run} would 404")

    def test_glitch_row_does_not_drop_audio(self) -> None:
        """The audio decision reads the served rows, not the glitch."""
        self._insert("m1", 1000.0, 1010.0, "main", True)
        self._insert("m2", 1010.0, 1010.5, "main", False)
        self._insert("s1", 1010.0, 1020.0, "sub", True)
        exporter = _exporter(1000.0, 1020.0)

        _spans, _codecs, keep_audio = exporter._resolve_coverage()

        self.assertTrue(keep_audio)


class TestUnstagedAutoRows(ExportPlanDbTestCase):
    def test_long_sub_export_ignores_a_dropped_main_edge_row(self) -> None:
        """A sub-only run pages through sub rows, not a sliver of main."""
        start = 1000.0
        end = start + MAX_PLAYLIST_SECONDS + 800
        # overlaps the range by under the resolver's minimum interval
        self._insert("m1", 995.0, 1000.05, "main", True)
        seg = start
        idx = 0
        while seg < end:
            self._insert(f"s{idx}", seg, seg + 10.0, "sub", True)
            seg += 10.0
            idx += 1
        exporter = _exporter(start, end)

        self.assertEqual(self._staged_runs(exporter), [])
        _cmd, playlist_lines = exporter.get_record_export_command("/exports/o.mp4")

        # before the fix this was one page spanning the few-hundredths of
        # a second main row, turning hours of sub into a blip of video
        self.assertEqual(
            playlist_lines,
            [
                f"file 'http://127.0.0.1:5000/vod/{CAMERA}"
                f"/start/{start}/end/{end}/index.m3u8'"
            ],
        )

    def test_short_sub_export_chapters_come_from_sub(self) -> None:
        self._insert("m1", 995.0, 1000.05, "main", True)
        self._insert("s1", 1000.0, 1010.0, "sub", True)
        self._insert("s2", 1010.0, 1020.0, "sub", True)
        exporter = _exporter(1000.0, 1020.0)
        exporter.chapters = ChaptersEnum.recording_segments

        with patch.object(
            RecordingExporter,
            "_build_recording_segment_chapter_metadata_file",
            return_value=None,
        ) as chapters:
            exporter.get_record_export_command("/exports/o.mp4")

        rows = chapters.call_args.args[0]
        self.assertEqual(
            [(r.start_time, r.end_time) for r in rows],
            [(1000.0, 1010.0), (1010.0, 1020.0)],
        )

    def test_main_run_reads_main_rows(self) -> None:
        self._insert("m1", 1000.0, 1020.0, "main", True)
        self._insert("s1", 1000.0, 1020.0, "sub", True)
        exporter = _exporter(1000.0, 1020.0)

        rows = exporter._single_run_recordings()

        self.assertEqual([(r.start_time, r.end_time) for r in rows], [(1000.0, 1020.0)])

    def test_no_resolved_coverage_falls_back_to_main_then_sub(self) -> None:
        exporter = _exporter(1000.0, 1020.0)
        exporter._coverage = ([], set(), False)
        by_stream = {"main": [], "sub": ["sub-row"]}

        with patch.object(
            RecordingExporter,
            "_get_recordings_for_range",
            side_effect=lambda stream: by_stream[stream],
        ):
            self.assertEqual(exporter._single_run_recordings(), ["sub-row"])
            by_stream["main"] = ["main-row"]
            self.assertEqual(exporter._single_run_recordings(), ["main-row"])


if __name__ == "__main__":
    unittest.main()
