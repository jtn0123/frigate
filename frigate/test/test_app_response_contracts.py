"""Keep common JSON response schemas aligned with real response shapes."""

import unittest

from frigate.api.app import ffmpeg_presets
from frigate.api.defs.response.fork_app import (
    ActiveProfileResponse,
    FFmpegPresetsResponse,
    ProfilesResponse,
)
from frigate.api.defs.response.review_response import DayReview, ReviewSummaryResponse


class TestAppResponseContracts(unittest.TestCase):
    def test_review_summary_matches_day_keyed_payload(self):
        response = {
            "last24Hours": {
                "reviewed_alert": 1,
                "reviewed_detection": 0,
                "total_alert": 2,
                "total_detection": 2,
            },
            "2026-06-05": {
                "day": "2026-06-05",
                "reviewed_alert": 1,
                "reviewed_detection": 0,
                "total_alert": 2,
                "total_detection": 2,
            },
        }
        parsed = ReviewSummaryResponse.model_validate(response)
        day = parsed.root["2026-06-05"]
        self.assertIsInstance(day, DayReview)
        self.assertEqual(day.day.isoformat(), "2026-06-05")
        self.assertNotIn("root", response)

    def test_profile_and_ffmpeg_contracts_accept_current_payloads(self):
        ProfilesResponse.model_validate(
            {
                "profiles": [{"name": "home", "friendly_name": "Home"}],
                "active_profile": "home",
                "last_activated": {"home": 1_700_000_000.0},
            }
        )
        ActiveProfileResponse.model_validate({"active_profile": None})
        FFmpegPresetsResponse.model_validate(
            {
                "hwaccel_args": ["preset-vaapi"],
                "input_args": ["preset-rtsp-generic"],
                "output_args": {"record": ["preset-record-generic"], "detect": []},
            }
        )

    def test_ffmpeg_endpoint_matches_its_declared_response(self):
        response = ffmpeg_presets()
        parsed = FFmpegPresetsResponse.model_validate(response)
        self.assertIn("record", parsed.output_args)
