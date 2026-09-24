"""Argument checks of the chat export and event image tools, plus the object
names endpoint the chat tools share (D56)."""

import asyncio
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from frigate.api import app as app_api
from frigate.api.chat import _execute_create_export, _execute_get_event_image
from frigate.api.chat_util import format_events_with_local_time, format_local_time
from frigate.test.test_chat_tool_approval import (
    DatabaseTestCase,
    _jpeg_base64,
    _request,
)


def _iso(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%dT%H:%M:%S")


def _export_args(**overrides):
    args = {
        "camera": "driveway",
        "start_time": _iso(1_700_000_100),
        "end_time": _iso(1_700_000_200),
    }
    args.update(overrides)
    return args


class TestCreateExportArguments(unittest.TestCase):
    def test_unknown_camera(self):
        result = asyncio.run(
            _execute_create_export(
                _request(), _export_args(camera="attic"), ["driveway", "attic"]
            )
        )
        self.assertEqual(result, {"error": "Camera 'attic' not found."})

    def test_unknown_source(self):
        result = asyncio.run(
            _execute_create_export(_request(), _export_args(source="dvd"), ["driveway"])
        )
        self.assertEqual(result, {"error": "source must be 'recordings' or 'preview'."})


class TestEventImageArguments(DatabaseTestCase):
    def test_event_id_is_required(self):
        result = asyncio.run(
            _execute_get_event_image(_request(), {"event_id": "  "}, ["driveway"])
        )
        self.assertEqual(result, {"error": "event_id is required."})

    def test_image_type_must_be_known(self):
        result = asyncio.run(
            _execute_get_event_image(
                _request(), {"event_id": "evt", "image": "clip"}, ["driveway"]
            )
        )
        self.assertEqual(result, {"error": "image must be 'thumbnail' or 'snapshot'."})

    def test_snapshot_is_used_when_the_event_has_one(self):
        self.make_event("evt", thumbnail=_jpeg_base64(), has_snapshot=True)
        snapshot = np.zeros((20, 30, 3), np.uint8)

        with patch(
            "frigate.api.chat.load_event_snapshot_image",
            return_value=(snapshot, False),
        ) as load:
            result = asyncio.run(
                _execute_get_event_image(
                    _request(), {"event_id": "evt", "image": "snapshot"}, ["driveway"]
                )
            )

        load.assert_called_once()
        self.assertEqual(result["image"], "snapshot")
        self.assertNotIn("note", result)
        self.assertEqual(result["end_time_local"], format_local_time(1_700_000_110))
        self.assertIn("snapshot for event evt", result["_image_text"])


class TestFormatEventsWithLocalTime(unittest.TestCase):
    def test_adds_local_times_without_changing_the_input(self):
        events = [{"id": "a", "start_time": 1_700_000_000, "end_time": 1_700_000_060}]

        result = format_events_with_local_time(events)

        self.assertEqual(
            result[0]["start_time_local"], format_local_time(1_700_000_000)
        )
        self.assertEqual(result[0]["end_time_local"], format_local_time(1_700_000_060))
        self.assertNotIn("start_time_local", events[0])
        # 12 hour clock with seconds, as quoted back to users
        self.assertRegex(
            result[0]["start_time_local"],
            r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (AM|PM)$",
        )

    def test_in_progress_event_has_no_end_time(self):
        result = format_events_with_local_time(
            [{"id": "a", "start_time": 1_700_000_000, "end_time": None}]
        )
        self.assertNotIn("end_time_local", result[0])


class TestCategorizedObjectNamesEndpoint(unittest.TestCase):
    def test_passes_the_filter_and_allowed_cameras(self):
        config = object()
        request = SimpleNamespace(app=SimpleNamespace(frigate_config=config))

        with patch.object(
            app_api,
            "get_categorized_object_names",
            return_value={"person": ["Alice"]},
        ) as names:
            response = app_api.categorized_object_names(
                request, object_type="person", allowed_cameras=["driveway"]
            )

        names.assert_called_once_with(config, ["driveway"], "person")
        self.assertEqual(response.body, b'{"person":["Alice"]}')


if __name__ == "__main__":
    unittest.main()
