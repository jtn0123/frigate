"""Regressions for the selected upstream reliability backports."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, mock_open, patch

from pydantic import ValidationError

from frigate.output.preview import get_most_recent_preview_frame
from frigate.track.norfair_tracker import NorfairTracker


class TestPreviewCameraIdentity(unittest.TestCase):
    def test_fallback_never_returns_a_camera_with_an_extended_name(self):
        with tempfile.TemporaryDirectory() as directory:
            other = Path(directory) / "preview_front-door-1000.0.webp"
            other.touch()
            with patch("frigate.output.preview.PREVIEW_CACHE_DIR", directory):
                for before in (None, 2000.0):
                    with self.subTest(before=before):
                        self.assertIsNone(
                            get_most_recent_preview_frame("front", before)
                        )
                        self.assertEqual(
                            get_most_recent_preview_frame("front-door", before),
                            str(other),
                        )

    def test_fallback_keeps_own_frame_when_other_camera_is_newer(self):
        with tempfile.TemporaryDirectory() as directory:
            own = Path(directory) / "preview_front-1000.0.webp"
            own.touch()
            (Path(directory) / "preview_front-door-2000.0.webp").touch()
            with patch("frigate.output.preview.PREVIEW_CACHE_DIR", directory):
                self.assertEqual(get_most_recent_preview_frame("front"), str(own))
                self.assertIsNone(get_most_recent_preview_frame("front", 999.0))


class TestTrackerDeregistration(unittest.TestCase):
    def test_expiring_one_track_preserves_other_healthy_tracks(self):
        for max_frames in (None, 100):
            with self.subTest(max_frames=max_frames):
                objects = [
                    SimpleNamespace(global_id=1, hit_counter=5),
                    SimpleNamespace(global_id=2, hit_counter=5),
                ]
                tracker = SimpleNamespace(tracked_objects=objects)
                subject = NorfairTracker.__new__(NorfairTracker)
                subject.tracked_objects = {"one": {"label": "car"}}
                subject.disappeared = {"one": 0}
                subject.track_id_map = {"1": "one"}
                subject.detect_config = SimpleNamespace(
                    stationary=SimpleNamespace(
                        max_frames=SimpleNamespace(objects={}, default=max_frames)
                    )
                )
                with patch.object(subject, "get_tracker", return_value=tracker):
                    subject.deregister("one", "1")
                self.assertEqual(
                    [obj.global_id for obj in tracker.tracked_objects],
                    [1, 2] if max_frames is None else [2],
                )
                self.assertEqual(subject.tracked_objects, {})
                self.assertEqual(subject.disappeared, {})
                self.assertEqual(subject.track_id_map, {})


class TestValidateConfigExit(unittest.TestCase):
    def _run(self, validate: bool, invalid: bool):
        from frigate import __main__ as entry

        error = ValidationError.from_exception_data(
            "FrigateConfig", [{"type": "missing", "loc": ("mqtt",), "input": {}}]
        )
        config = MagicMock()
        with (
            patch.object(entry.mp, "Manager"),
            patch.object(entry.mp, "Event"),
            patch.object(entry.faulthandler, "enable"),
            patch.object(entry, "setup_logging"),
            patch.object(entry.threading, "current_thread"),
            patch.object(entry.signal, "signal"),
            patch.object(
                entry.sys,
                "argv",
                ["frigate"] + (["--validate-config"] if validate else []),
            ),
            patch.object(entry, "find_config_file", return_value="unused.yml"),
            patch("builtins.open", mock_open(read_data="{}")),
            patch("builtins.print"),
            patch.object(
                entry.FrigateConfig,
                "load",
                side_effect=[error, config] if invalid else [config],
            ) as load,
            patch.object(entry, "FrigateApp") as app,
        ):
            if validate:
                with self.assertRaises(SystemExit) as raised:
                    entry.main()
                self.assertEqual(raised.exception.code, 1 if invalid else 0)
                app.assert_not_called()
                self.assertEqual(load.call_count, 1)
            else:
                entry.main()
                load.assert_called_with(install=True, safe_load=True)
                app.return_value.start.assert_called_once()

    def test_invalid_config_exits_before_successful_safe_mode_fallback(self):
        self._run(validate=True, invalid=True)

    def test_valid_config_exits_successfully(self):
        self._run(validate=True, invalid=False)

    def test_normal_startup_preserves_safe_mode_recovery(self):
        self._run(validate=False, invalid=True)
