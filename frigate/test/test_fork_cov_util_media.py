"""Coverage for the media sync helpers and keyframe probing in frigate.util.media."""

import asyncio
import datetime
import errno
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from peewee import DatabaseError, SqliteDatabase

from frigate.models import (
    Event,
    Export,
    ExportCase,
    Previews,
    Recordings,
    RecordingsToDelete,
    ReviewSegment,
)
from frigate.util import media
from frigate.util.media import (
    MediaSyncResults,
    SyncResult,
    get_keyframe_offsets,
    remove_empty_directories,
    sync_all_media,
    sync_event_snapshots,
    sync_event_thumbnails,
    sync_exports,
    sync_previews,
    sync_recordings,
    sync_review_thumbnails,
    write_orphan_report,
)

MODELS = [
    Event,
    Export,
    ExportCase,
    Previews,
    Recordings,
    RecordingsToDelete,
    ReviewSegment,
]

OLD = time.time() - 86400


def touch(path: Path, old: bool = False) -> Path:
    """Create a file (and its parents), optionally backdated past the grace window."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"data")
    if old:
        os.utime(path, (OLD, OLD))
    return path


class MediaTestBase(unittest.TestCase):
    """Bind the media models to an in-memory database and patch media dirs."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record_dir = self.root / "recordings"
        self.clips_dir = self.root / "clips"
        self.thumb_dir = self.clips_dir / "thumbs"
        self.export_dir = self.root / "exports"
        for directory in (
            self.record_dir,
            self.clips_dir,
            self.thumb_dir,
            self.export_dir,
        ):
            directory.mkdir(parents=True)

        self.database = SqliteDatabase(":memory:")
        binding = self.database.bind_ctx(MODELS)
        binding.__enter__()
        self.addCleanup(binding.__exit__, None, None, None)
        self.database.create_tables(
            [Event, ExportCase, Export, Previews, Recordings, ReviewSegment]
        )
        self.addCleanup(self.database.close)

        for name, value in (
            ("RECORD_DIR", self.record_dir),
            ("CLIPS_DIR", self.clips_dir),
            ("THUMB_DIR", self.thumb_dir),
            ("EXPORT_DIR", self.export_dir),
        ):
            patcher = patch(f"frigate.util.media.{name}", str(value))
            patcher.start()
            self.addCleanup(patcher.stop)

    def add_event(
        self,
        event_id: str,
        camera: str = "front",
        has_snapshot: bool = True,
        thumbnail: str = "",
    ) -> None:
        Event.create(
            id=event_id,
            label="person",
            camera=camera,
            start_time=1,
            end_time=2,
            top_score=0.9,
            score=0.9,
            false_positive=False,
            zones=[],
            thumbnail=thumbnail,
            has_snapshot=has_snapshot,
            region=[],
            box=[],
            area=1,
            plus_id="",
            model_hash="",
            detector_type="",
            model_type="",
            data={},
        )

    def add_recording(
        self, rec_id: str, path: Path, start_time: float = 1.0, exists: bool = True
    ) -> None:
        if exists:
            touch(path, old=True)
        Recordings.create(
            id=rec_id,
            camera="front",
            path=str(path),
            start_time=start_time,
            end_time=start_time + 10,
            duration=10,
        )


class TestSyncResult(unittest.TestCase):
    def test_to_dict_omits_path_lists(self) -> None:
        result = SyncResult(
            media_type="previews",
            files_checked=3,
            orphans_found=2,
            orphans_deleted=1,
            orphan_paths=["/a"],
            aborted=True,
            error="boom",
        )
        self.assertEqual(
            result.to_dict(),
            {
                "media_type": "previews",
                "files_checked": 3,
                "orphans_found": 2,
                "orphans_deleted": 1,
                "aborted": True,
                "error": "boom",
            },
        )


class TestRemoveEmptyDirectories(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_removes_empty_chain_up_to_root(self) -> None:
        leaf = self.root / "a" / "b" / "c"
        leaf.mkdir(parents=True)
        remove_empty_directories(self.root, [leaf])
        self.assertFalse((self.root / "a").exists())
        self.assertTrue(self.root.exists())

    def test_keeps_non_empty_and_ignores_missing(self) -> None:
        keep = self.root / "keep"
        touch(keep / "file.txt")
        missing = self.root / "missing" / "deeper"
        remove_empty_directories(self.root, [keep, missing, self.root])
        self.assertTrue(keep.exists())
        self.assertTrue(self.root.exists())

    def test_unexpected_os_error_is_raised(self) -> None:
        path = MagicMock(spec=Path)
        path.rmdir.side_effect = OSError(errno.EACCES, "denied")
        with self.assertRaises(OSError):
            remove_empty_directories(self.root, [path])


class TestIsStaleRecordingOrphan(MediaTestBase):
    def test_missing_file_is_not_stale(self) -> None:
        self.assertFalse(
            media._is_stale_recording_orphan(
                str(self.record_dir / "gone.mp4"), time.time()
            )
        )

    def test_recent_file_is_not_stale(self) -> None:
        path = touch(self.record_dir / "new.mp4")
        self.assertFalse(
            media._is_stale_recording_orphan(str(path), time.time() - 3600)
        )

    def test_old_registered_file_is_not_stale(self) -> None:
        path = self.record_dir / "reg.mp4"
        self.add_recording("r1", path)
        self.assertFalse(media._is_stale_recording_orphan(str(path), time.time()))

    def test_old_unregistered_file_is_stale(self) -> None:
        path = touch(self.record_dir / "orphan.mp4", old=True)
        self.assertTrue(media._is_stale_recording_orphan(str(path), time.time()))


class TestSyncRecordings(MediaTestBase):
    def test_deletes_db_entries_for_missing_files(self) -> None:
        for index in range(4):
            self.add_recording(f"r{index}", self.record_dir / f"{index}.mp4")
        missing = self.record_dir / "missing.mp4"
        self.add_recording("gone", missing, exists=False)

        result = sync_recordings()

        self.assertFalse(result.aborted)
        self.assertIsNone(result.error)
        self.assertEqual(result.orphan_db_paths, [str(missing)])
        self.assertEqual(result.orphans_found, 1)
        self.assertEqual(result.orphans_deleted, 1)
        self.assertEqual(Recordings.select().count(), 4)
        self.assertEqual(result.files_checked, 4)

    def test_dry_run_keeps_missing_db_entries(self) -> None:
        for index in range(3):
            self.add_recording(f"r{index}", self.record_dir / f"{index}.mp4")
        self.add_recording("gone", self.record_dir / "missing.mp4", exists=False)

        result = sync_recordings(dry_run=True)

        self.assertEqual(result.orphans_found, 1)
        self.assertEqual(result.orphans_deleted, 0)
        self.assertEqual(Recordings.select().count(), 4)

    def test_db_safety_threshold_aborts(self) -> None:
        self.add_recording("r0", self.record_dir / "0.mp4")
        for index in range(3):
            self.add_recording(
                f"gone{index}", self.record_dir / f"g{index}.mp4", exists=False
            )

        result = sync_recordings()

        self.assertTrue(result.aborted)
        self.assertEqual(result.orphans_found, 3)
        self.assertEqual(Recordings.select().count(), 4)

    def test_db_safety_threshold_bypassed_with_force(self) -> None:
        self.add_recording("r0", self.record_dir / "0.mp4")
        for index in range(3):
            self.add_recording(
                f"gone{index}", self.record_dir / f"g{index}.mp4", exists=False
            )

        result = sync_recordings(force=True)

        self.assertFalse(result.aborted)
        self.assertEqual(result.orphans_deleted, 3)
        self.assertEqual(Recordings.select().count(), 1)

    def test_db_delete_error_aborts_before_file_cleanup(self) -> None:
        self.add_recording("r0", self.record_dir / "0.mp4")
        self.add_recording("r1", self.record_dir / "1.mp4")
        self.add_recording("gone", self.record_dir / "g.mp4", exists=False)
        orphan = touch(self.record_dir / "orphan.mp4", old=True)

        real_delete = Recordings.delete

        def failing_delete():
            query = real_delete()
            query.execute = MagicMock(side_effect=DatabaseError("locked"))
            return query

        with patch.object(Recordings, "delete", side_effect=failing_delete):
            result = sync_recordings()

        self.assertTrue(result.aborted)
        self.assertEqual(result.error, "locked")
        self.assertTrue(orphan.exists())

    def test_file_safety_threshold_aborts_and_force_deletes(self) -> None:
        self.add_recording("r0", self.record_dir / "0.mp4")
        orphans = [
            touch(self.record_dir / f"orphan{index}.mp4", old=True)
            for index in range(3)
        ]

        result = sync_recordings()
        self.assertTrue(result.aborted)
        self.assertTrue(all(path.exists() for path in orphans))

        result = sync_recordings(force=True)
        self.assertFalse(result.aborted)
        self.assertEqual(result.orphans_deleted, 3)
        self.assertFalse(any(path.exists() for path in orphans))

    def test_unlink_failure_is_logged_and_not_counted(self) -> None:
        for index in range(3):
            self.add_recording(f"r{index}", self.record_dir / f"{index}.mp4")
        touch(self.record_dir / "orphan.mp4", old=True)

        with patch(
            "frigate.util.media.os.unlink", side_effect=PermissionError("denied")
        ):
            result = sync_recordings()

        self.assertEqual(result.orphans_found, 1)
        self.assertEqual(result.orphans_deleted, 0)
        self.assertIsNone(result.error)

    def test_limited_only_scans_recent_hours(self) -> None:
        now = datetime.datetime.now().astimezone(datetime.UTC)
        recent_dir = self.record_dir / now.strftime("%Y-%m-%d/%H") / "front"
        old_dir = self.record_dir / "2000-01-01" / "00" / "front"
        for index in range(3):
            self.add_recording(
                f"r{index}",
                recent_dir / f"{index}.mp4",
                start_time=now.timestamp(),
            )
        # An old DB row outside the window whose file is missing is ignored.
        self.add_recording("ancient", old_dir / "x.mp4", start_time=1, exists=False)
        recent_orphan = touch(recent_dir / "orphan.mp4", old=True)
        old_orphan = touch(old_dir / "orphan.mp4", old=True)

        result = sync_recordings(limited=True)

        self.assertFalse(result.aborted)
        self.assertEqual(result.files_checked, 4)
        self.assertEqual(result.orphan_paths, [str(recent_orphan)])
        self.assertFalse(recent_orphan.exists())
        self.assertTrue(old_orphan.exists())
        self.assertEqual(Recordings.select().count(), 4)

    def test_file_that_stops_being_stale_before_delete_is_kept(self) -> None:
        for index in range(3):
            self.add_recording(f"r{index}", self.record_dir / f"{index}.mp4")
        orphan = touch(self.record_dir / "orphan.mp4", old=True)

        checks: list[str] = []

        def stale_only_on_first_check(path: str, _cutoff: float) -> bool:
            # Stale during the scan, then registered or rewritten before deletion.
            checks.append(path)
            return path == str(orphan) and checks.count(path) == 1

        with patch(
            "frigate.util.media._is_stale_recording_orphan",
            side_effect=stale_only_on_first_check,
        ):
            result = sync_recordings()

        self.assertEqual(result.orphan_paths, [str(orphan)])
        self.assertEqual(result.orphans_deleted, 0)
        self.assertTrue(orphan.exists())

    def test_unexpected_error_is_captured(self) -> None:
        with patch.object(Recordings, "select", side_effect=RuntimeError("boom")):
            result = sync_recordings()
        self.assertEqual(result.error, "boom")


class TestSyncEventSnapshots(MediaTestBase):
    def setUp(self) -> None:
        super().setUp()
        for index in range(3):
            self.add_event(f"e{index}")
            touch(self.clips_dir / f"front-e{index}-clean.webp")
        self.add_event("legacy")
        touch(self.clips_dir / "front-legacy.jpg")
        touch(self.clips_dir / "front-legacy-clean.png")
        touch(self.clips_dir / "ignored.txt")
        (self.clips_dir / "subdir.jpg").mkdir()

    def test_no_orphans(self) -> None:
        result = sync_event_snapshots()
        self.assertEqual(result.files_checked, 5)
        self.assertEqual(result.orphans_found, 0)

    def test_deletes_orphans_and_event_without_snapshot(self) -> None:
        self.add_event("nosnap", has_snapshot=False)
        stale = touch(self.clips_dir / "front-nosnap-clean.webp")
        orphan = touch(self.clips_dir / "front-missing.jpg")

        dry = sync_event_snapshots(dry_run=True)
        self.assertEqual(sorted(dry.orphan_paths), sorted([str(stale), str(orphan)]))
        self.assertTrue(stale.exists())

        result = sync_event_snapshots()
        self.assertEqual(result.orphans_deleted, 2)
        self.assertFalse(stale.exists())
        self.assertFalse(orphan.exists())
        self.assertTrue((self.clips_dir / "front-legacy.jpg").exists())

    def test_safety_threshold_and_force(self) -> None:
        for index in range(6):
            touch(self.clips_dir / f"front-orphan{index}-clean.webp")
        result = sync_event_snapshots()
        self.assertTrue(result.aborted)
        self.assertEqual(result.orphans_deleted, 0)

        result = sync_event_snapshots(force=True)
        self.assertFalse(result.aborted)
        self.assertEqual(result.orphans_deleted, 6)

    def test_unlink_failure(self) -> None:
        touch(self.clips_dir / "front-missing.jpg")
        with patch("frigate.util.media.os.unlink", side_effect=OSError("nope")):
            result = sync_event_snapshots()
        self.assertEqual(result.orphans_found, 1)
        self.assertEqual(result.orphans_deleted, 0)

    def test_missing_clips_dir(self) -> None:
        with patch("frigate.util.media.CLIPS_DIR", str(self.root / "nope")):
            result = sync_event_snapshots()
        self.assertEqual(result.files_checked, 0)

    def test_error_captured(self) -> None:
        with patch.object(Event, "select", side_effect=RuntimeError("db down")):
            result = sync_event_snapshots()
        self.assertEqual(result.error, "db down")


class TestSyncEventThumbnails(MediaTestBase):
    def setUp(self) -> None:
        super().setUp()
        for index in range(4):
            self.add_event(f"e{index}")
            touch(self.thumb_dir / "front" / f"e{index}.webp")
        touch(self.thumb_dir / "front" / "notes.txt")
        touch(self.thumb_dir / "stray-file")

    def test_no_orphans(self) -> None:
        result = sync_event_thumbnails()
        self.assertEqual(result.files_checked, 4)
        self.assertEqual(result.orphans_found, 0)

    def test_orphan_classification(self) -> None:
        self.add_event("inline", thumbnail="base64data")
        inline = touch(self.thumb_dir / "front" / "inline.webp")
        missing = touch(self.thumb_dir / "front" / "missing.webp")
        # The event exists with a file thumbnail but under another camera dir,
        # so it is kept rather than treated as an orphan.
        other_cam = touch(self.thumb_dir / "back" / "e0.webp")

        dry = sync_event_thumbnails(dry_run=True)
        self.assertEqual(sorted(dry.orphan_paths), sorted([str(inline), str(missing)]))
        self.assertTrue(inline.exists())

        result = sync_event_thumbnails()
        self.assertEqual(result.orphans_deleted, 2)
        self.assertFalse(inline.exists())
        self.assertFalse(missing.exists())
        self.assertTrue(other_cam.exists())

    def test_safety_threshold_and_force(self) -> None:
        for index in range(5):
            touch(self.thumb_dir / "front" / f"orphan{index}.webp")
        self.assertTrue(sync_event_thumbnails().aborted)
        result = sync_event_thumbnails(force=True)
        self.assertEqual(result.orphans_deleted, 5)

    def test_unlink_failure(self) -> None:
        touch(self.thumb_dir / "front" / "missing.webp")
        with patch("frigate.util.media.os.unlink", side_effect=OSError("nope")):
            result = sync_event_thumbnails()
        self.assertEqual(result.orphans_deleted, 0)
        self.assertEqual(result.orphans_found, 1)

    def test_missing_thumb_dir(self) -> None:
        with patch("frigate.util.media.THUMB_DIR", str(self.root / "nope")):
            self.assertEqual(sync_event_thumbnails().files_checked, 0)

    def test_error_captured(self) -> None:
        with patch.object(Event, "select", side_effect=RuntimeError("db down")):
            self.assertEqual(sync_event_thumbnails().error, "db down")


class TestSyncReviewThumbnails(MediaTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.review_dir = self.clips_dir / "review"
        for index in range(3):
            path = touch(self.review_dir / f"thumb-front-r{index}.webp")
            ReviewSegment.create(
                id=f"r{index}",
                camera="front",
                start_time=1,
                end_time=2,
                severity="alert",
                thumb_path=str(path),
                data={},
            )
        touch(self.review_dir / "other.webp")
        touch(self.review_dir / "thumb-front-r9.jpg")

    def test_no_orphans(self) -> None:
        result = sync_review_thumbnails()
        self.assertEqual(result.files_checked, 3)
        self.assertEqual(result.orphans_found, 0)

    def test_dry_run_then_delete(self) -> None:
        orphan = touch(self.review_dir / "thumb-front-gone.webp")
        self.assertTrue(sync_review_thumbnails(dry_run=True).orphans_found == 1)
        self.assertTrue(orphan.exists())
        result = sync_review_thumbnails()
        self.assertEqual(result.orphans_deleted, 1)
        self.assertFalse(orphan.exists())

    def test_safety_threshold_and_force(self) -> None:
        for index in range(4):
            touch(self.review_dir / f"thumb-front-gone{index}.webp")
        self.assertTrue(sync_review_thumbnails().aborted)
        self.assertEqual(sync_review_thumbnails(force=True).orphans_deleted, 4)

    def test_unlink_failure(self) -> None:
        touch(self.review_dir / "thumb-front-gone.webp")
        with patch("frigate.util.media.os.unlink", side_effect=OSError("nope")):
            self.assertEqual(sync_review_thumbnails().orphans_deleted, 0)

    def test_missing_review_dir(self) -> None:
        with patch("frigate.util.media.CLIPS_DIR", str(self.root / "nope")):
            self.assertEqual(sync_review_thumbnails().files_checked, 0)

    def test_error_captured(self) -> None:
        with patch.object(ReviewSegment, "select", side_effect=RuntimeError("x")):
            self.assertEqual(sync_review_thumbnails().error, "x")


class TestSyncPreviews(MediaTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.previews_dir = self.clips_dir / "previews"
        for index in range(3):
            path = touch(self.previews_dir / "front" / f"p{index}.mp4")
            Previews.create(
                id=f"p{index}",
                camera="front",
                path=str(path),
                start_time=1,
                end_time=2,
                duration=1,
            )
        touch(self.previews_dir / "front" / "cache.webp")
        touch(self.previews_dir / "stray.mp4")

    def test_no_orphans(self) -> None:
        result = sync_previews()
        self.assertEqual(result.files_checked, 3)
        self.assertEqual(result.orphans_found, 0)

    def test_dry_run_then_delete(self) -> None:
        orphan = touch(self.previews_dir / "front" / "gone.mp4")
        self.assertEqual(sync_previews(dry_run=True).orphans_found, 1)
        self.assertTrue(orphan.exists())
        self.assertEqual(sync_previews().orphans_deleted, 1)
        self.assertFalse(orphan.exists())

    def test_safety_threshold_and_force(self) -> None:
        for index in range(4):
            touch(self.previews_dir / "back" / f"gone{index}.mp4")
        self.assertTrue(sync_previews().aborted)
        self.assertEqual(sync_previews(force=True).orphans_deleted, 4)

    def test_unlink_failure(self) -> None:
        touch(self.previews_dir / "front" / "gone.mp4")
        with patch("frigate.util.media.os.unlink", side_effect=OSError("nope")):
            self.assertEqual(sync_previews().orphans_deleted, 0)

    def test_missing_previews_dir(self) -> None:
        with patch("frigate.util.media.CLIPS_DIR", str(self.root / "nope")):
            self.assertEqual(sync_previews().files_checked, 0)

    def test_error_captured(self) -> None:
        with patch.object(Previews, "select", side_effect=RuntimeError("x")):
            self.assertEqual(sync_previews().error, "x")


class TestSyncExports(MediaTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.export_thumb_dir = self.clips_dir / "export"
        for index in range(2):
            video = touch(self.export_dir / f"x{index}.mp4")
            thumb = touch(self.export_thumb_dir / f"x{index}.jpg")
            Export.create(
                id=f"x{index}",
                camera="front",
                name=f"export {index}",
                date=1,
                video_path=str(video),
                thumb_path=str(thumb),
                in_progress=False,
            )
        Export.create(
            id="blank",
            camera="front",
            name="blank",
            date=1,
            video_path="",
            thumb_path="",
            in_progress=True,
        )
        touch(self.export_dir / "notes.txt")
        touch(self.export_thumb_dir / "notes.txt")

    def test_no_orphans(self) -> None:
        result = sync_exports()
        self.assertEqual(result.files_checked, 4)
        self.assertEqual(result.orphans_found, 0)

    def test_dry_run_then_delete(self) -> None:
        video = touch(self.export_dir / "gone.mp4")
        thumb = touch(self.export_thumb_dir / "gone.jpg")
        dry = sync_exports(dry_run=True)
        self.assertEqual(dry.orphan_paths, [str(video), str(thumb)])
        self.assertTrue(video.exists())
        result = sync_exports()
        self.assertEqual(result.orphans_deleted, 2)
        self.assertFalse(video.exists())
        self.assertFalse(thumb.exists())

    def test_safety_threshold_and_force(self) -> None:
        for index in range(5):
            touch(self.export_dir / f"gone{index}.mp4")
        self.assertTrue(sync_exports().aborted)
        self.assertEqual(sync_exports(force=True).orphans_deleted, 5)

    def test_unlink_failure(self) -> None:
        touch(self.export_dir / "gone.mp4")
        with patch("frigate.util.media.os.unlink", side_effect=OSError("nope")):
            self.assertEqual(sync_exports().orphans_deleted, 0)

    def test_missing_dirs(self) -> None:
        with (
            patch("frigate.util.media.EXPORT_DIR", str(self.root / "a")),
            patch("frigate.util.media.CLIPS_DIR", str(self.root / "b")),
        ):
            self.assertEqual(sync_exports().files_checked, 0)

    def test_error_captured(self) -> None:
        with patch.object(Export, "select", side_effect=RuntimeError("x")):
            self.assertEqual(sync_exports().error, "x")


class TestMediaSyncResultsAndReport(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.results = MediaSyncResults(
            recordings=SyncResult(
                media_type="recordings",
                files_checked=10,
                orphans_found=2,
                orphans_deleted=1,
                orphan_paths=["/rec/a.mp4"],
                orphan_db_paths=["/rec/b.mp4"],
            ),
            previews=SyncResult(
                media_type="previews",
                files_checked=5,
                orphans_found=1,
                orphans_deleted=1,
                orphan_paths=["/prev/p.mp4"],
                aborted=True,
                error="x",
            ),
            exports=SyncResult(media_type="exports", files_checked=1),
        )

    def test_totals_and_to_dict(self) -> None:
        self.assertEqual(self.results.total_files_checked, 16)
        self.assertEqual(self.results.total_orphans_found, 3)
        self.assertEqual(self.results.total_orphans_deleted, 2)
        data = self.results.to_dict()
        self.assertEqual(set(data), {"recordings", "previews", "exports", "totals"})
        self.assertEqual(
            data["previews"],
            {
                "files_checked": 5,
                "orphans_found": 1,
                "orphans_deleted": 1,
                "aborted": True,
                "error": "x",
            },
        )
        self.assertEqual(
            data["totals"],
            {"files_checked": 16, "orphans_found": 3, "orphans_deleted": 2},
        )

    def test_empty_results(self) -> None:
        empty = MediaSyncResults()
        self.assertEqual(empty.total_files_checked, 0)
        self.assertEqual(
            empty.to_dict(),
            {"totals": {"files_checked": 0, "orphans_found": 0, "orphans_deleted": 0}},
        )

    def test_write_orphan_report(self) -> None:
        path = os.path.join(self.temp.name, "report.txt")
        write_orphan_report(self.results, path, job_id="job1", dry_run=True)
        with open(path) as f:
            text = f.read()
        self.assertTrue(text.startswith("# Media Sync Orphan Report\n# Job: job1\n"))
        self.assertIn("# Mode: dry_run=True", text)
        self.assertIn("## recordings - orphaned db entries (1)\n/rec/b.mp4\n", text)
        self.assertIn("## recordings - orphaned files (1)\n/rec/a.mp4\n", text)
        self.assertIn("## previews - orphaned files (1)\n/prev/p.mp4\n", text)
        self.assertNotIn("exports", text)
        self.assertNotIn("event_snapshots", text)

    def test_write_orphan_report_os_error_is_swallowed(self) -> None:
        path = os.path.join(self.temp.name, "missing-dir", "report.txt")
        with self.assertLogs("frigate.util.media", level="ERROR"):
            write_orphan_report(self.results, path)
        self.assertFalse(os.path.exists(path))


class TestSyncAllMedia(unittest.TestCase):
    NAMES = [
        "event_snapshots",
        "event_thumbnails",
        "review_thumbnails",
        "previews",
        "exports",
        "recordings",
    ]

    def _patch_all(self) -> dict[str, MagicMock]:
        mocks = {}
        for name in self.NAMES:
            func = "sync_" + name
            mock = MagicMock(return_value=SyncResult(media_type=name, files_checked=1))
            patcher = patch(f"frigate.util.media.{func}", mock)
            patcher.start()
            self.addCleanup(patcher.stop)
            mocks[name] = mock
        return mocks

    def test_all_runs_every_sync(self) -> None:
        mocks = self._patch_all()
        results = sync_all_media(dry_run=True, force=True)
        for name, mock in mocks.items():
            mock.assert_called_once_with(dry_run=True, force=True)
            self.assertIsNotNone(getattr(results, name))
        self.assertEqual(results.total_files_checked, 6)

    def test_selected_types_only(self) -> None:
        mocks = self._patch_all()
        results = sync_all_media(media_types=["previews", "recordings"])
        self.assertEqual(results.total_files_checked, 2)
        for name, mock in mocks.items():
            if name in ("previews", "recordings"):
                mock.assert_called_once_with(dry_run=False, force=False)
            else:
                mock.assert_not_called()
                self.assertIsNone(getattr(results, name))

    def test_single_type_skips_the_rest(self) -> None:
        mocks = self._patch_all()
        results = sync_all_media(media_types=["exports"])
        mocks["exports"].assert_called_once_with(dry_run=False, force=False)
        self.assertEqual(
            [name for name, mock in mocks.items() if mock.called], ["exports"]
        )
        self.assertIsNone(results.recordings)


def fake_proc(stdout: bytes = b"", returncode: int | None = 0) -> MagicMock:
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, b""))
    return proc


class TestGetKeyframeOffsets(unittest.TestCase):
    def run_with(self, exec_mock: AsyncMock) -> list[int] | None:
        with patch("frigate.util.media.asyncio.create_subprocess_exec", exec_mock):
            return asyncio.run(get_keyframe_offsets("/tmp/seg.mp4"))

    def test_parses_keyframes_only(self) -> None:
        output = (
            b"0.000000,K__\n0.040000,___\nbad line\n2.500000,K_\nnan-ish,K\n4.5,K\n"
        )
        exec_mock = AsyncMock(return_value=fake_proc(output))
        self.assertEqual(self.run_with(exec_mock), [0, 2500, 4500])
        args = exec_mock.call_args.args
        self.assertEqual(args[0], media.FFPROBE_PATH)
        self.assertEqual(args[-1], "/tmp/seg.mp4")

    def test_nonzero_exit_returns_none(self) -> None:
        exec_mock = AsyncMock(return_value=fake_proc(b"0.0,K\n", returncode=1))
        self.assertIsNone(self.run_with(exec_mock))

    def test_missing_ffprobe_returns_none(self) -> None:
        exec_mock = AsyncMock(side_effect=FileNotFoundError())
        self.assertIsNone(self.run_with(exec_mock))

    def test_timeout_kills_process(self) -> None:
        proc = fake_proc(returncode=None)
        proc.communicate = AsyncMock(side_effect=[TimeoutError(), (b"", b"")])
        proc.kill.side_effect = ProcessLookupError()
        exec_mock = AsyncMock(return_value=proc)
        self.assertIsNone(self.run_with(exec_mock))
        proc.kill.assert_called_once()
        self.assertEqual(proc.communicate.await_count, 2)

    def test_timeout_after_exit_skips_kill(self) -> None:
        proc = fake_proc(returncode=0)
        proc.communicate = AsyncMock(side_effect=TimeoutError())
        exec_mock = AsyncMock(return_value=proc)
        self.assertIsNone(self.run_with(exec_mock))
        proc.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
