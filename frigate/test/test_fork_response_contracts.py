"""Exercise public audio and diagnostic contracts through FastAPI serialization."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from frigate.api import review_audio
from frigate.api import stream_diagnostics as diagnostics
from frigate.api.auth import require_go2rtc_stream_access


class TestForkResponseContracts(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.frigate_config = SimpleNamespace(
            auth=SimpleNamespace(roles={"admin": {}}),
            proxy=SimpleNamespace(separator=","),
            cameras={"front": {}},
            go2rtc=SimpleNamespace(model_dump=lambda: {"streams": {"front": []}}),
            ffmpeg=SimpleNamespace(path="default"),
        )
        self.app.include_router(review_audio.router)
        self.app.include_router(diagnostics.router)
        self.app.dependency_overrides[require_go2rtc_stream_access] = lambda: None
        self.client = self.enterContext(TestClient(self.app))
        self.headers = {"remote-user": "admin", "remote-role": "admin"}
        diagnostics._cache.clear()
        diagnostics._inflight.clear()
        self.addCleanup(diagnostics._cache.clear)
        self.addCleanup(diagnostics._inflight.clear)

    def test_openapi_describes_both_success_bodies_and_audio_not_found(self):
        paths = self.app.openapi()["paths"]
        for path, method, name in (
            ("/review/{review_id}/audio", "get", "AudioResultsResponse"),
            (
                "/go2rtc/streams/{stream_name}/diagnostics",
                "post",
                "StreamDiagnosticsResponse",
            ),
        ):
            schema = paths[path][method]["responses"]["200"]["content"][
                "application/json"
            ]["schema"]
            self.assertEqual(schema, {"$ref": f"#/components/schemas/{name}"})
        self.assertIn("404", paths["/review/{review_id}/audio"]["get"]["responses"])

    def test_audio_availability_preserves_optional_fields_and_filters_extras(self):
        for status in ("available", "unavailable", "not_available"):
            expected = {"status": status, "chunks": []}
            if status == "available":
                expected["updated"] = 123.0
            with (
                self.subTest(status=status),
                patch.object(
                    review_audio.ReviewSegment,
                    "get",
                    return_value=SimpleNamespace(camera="front"),
                ),
                patch.object(
                    review_audio,
                    "read_results",
                    return_value={**expected, "private": 1},
                ),
            ):
                response = self.client.get("/review/test/audio", headers=self.headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), expected)

    def test_diagnostic_variants_preserve_missing_measurements(self):
        for status in (
            "healthy",
            "decode_error",
            "stream_unavailable",
            "timeout",
            "unavailable",
        ):
            diagnostics._cache.clear()
            expected = {
                "id": "probe",
                "stream": "front",
                "status": status,
                "codecs": [],
                "elapsed_ms": 10,
            }
            if status != "unavailable":
                expected.update(
                    producer_count=1,
                    received_bytes=20,
                    decoded_frames=0,
                    decoder_errors=0,
                )
            if status in ("healthy", "decode_error", "stream_unavailable"):
                expected["decoder_detail"] = ""
            with (
                self.subTest(status=status),
                patch.object(
                    diagnostics,
                    "collect_diagnostics",
                    new_callable=AsyncMock,
                    return_value={**expected, "private": "hidden"},
                ),
            ):
                response = self.client.post(
                    "/go2rtc/streams/front/diagnostics", json={}, headers=self.headers
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), expected)

    def test_invalid_audio_timestamp_falls_back_without_server_error(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(review_audio, "RESULTS", Path(directory)),
        ):
            path = Path(directory) / (hashlib.sha256(b"test").hexdigest() + ".json")
            for updated in ({"private": "value"}, float("nan")):
                path.write_text(
                    json.dumps(
                        {
                            "review_id": "test",
                            "camera": "front",
                            "chunks": [],
                            "updated": updated,
                        }
                    )
                )
                self.assertEqual(
                    review_audio.read_results("test", "front"),
                    {"status": "unavailable", "chunks": []},
                )
