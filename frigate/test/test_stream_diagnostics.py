"""Tests for bounded live-stream diagnostic probes."""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from frigate.api.stream_diagnostics import (
    decode_stream,
    safe_decoder_detail,
    safe_log_value,
    summarize_decode,
)


class TestDecodeSummary(unittest.TestCase):
    def test_successful_exit_with_corrupt_hevc_is_not_healthy(self):
        self.assertEqual(
            summarize_decode(0, "The cu_qp_delta -44 is outside the valid range", 50),
            "decode_error",
        )

    def test_no_decoded_frames_is_not_success(self):
        self.assertEqual(summarize_decode(0, "", 0), "stream_unavailable")

    def test_clean_frames_are_healthy(self):
        self.assertEqual(summarize_decode(0, "", 50), "healthy")

    def test_credentials_and_tokens_are_redacted(self):
        detail = safe_decoder_detail(
            "rtsp://admin:secret@camera/live?token=secret failed\n" * 20
        )
        self.assertNotIn("secret", detail)
        self.assertNotIn("admin", detail)
        self.assertLessEqual(len(detail.splitlines()), 6)

    def test_urls_are_omitted_even_without_credentials(self):
        self.assertEqual(
            safe_decoder_detail("Failed rtsp://camera/private-path?secret=1"),
            "Failed <redacted-url>",
        )

    def test_log_fields_cannot_add_lines(self):
        self.assertEqual(
            safe_log_value("yard\r\nforged entry"), "yard\\r\\nforged entry"
        )


class TestDiagnosticCollection(unittest.IsolatedAsyncioTestCase):
    async def test_collects_metadata_and_logs_safe_decoder_evidence(self):
        import httpx

        from frigate.api.stream_diagnostics import collect_diagnostics

        response = httpx.Response(
            200,
            request=httpx.Request("GET", "http://localhost/api/streams"),
            json={
                "yard": {
                    "producers": [
                        {"bytes_recv": 123, "medias": ["video H265", "audio AAC"]}
                    ]
                }
            },
        )
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get.return_value = response
        with (
            patch(
                "frigate.api.stream_diagnostics.httpx.AsyncClient", return_value=client
            ),
            patch(
                "frigate.api.stream_diagnostics.decode_stream",
                new_callable=AsyncMock,
                return_value={
                    "status": "decode_error",
                    "decoded_frames": 4,
                    "decoder_errors": 1,
                    "decoder_detail": "bad\r\nframe",
                },
            ),
            self.assertLogs("frigate.api.stream_diagnostics", level="WARNING") as logs,
        ):
            result = await collect_diagnostics("ffmpeg", "yard")
        self.assertEqual(result["producer_count"], 1)
        self.assertEqual(result["received_bytes"], 123)
        self.assertEqual(result["codecs"], ["AAC", "H265"])
        self.assertEqual(result["status"], "decode_error")
        self.assertNotIn("\r", logs.output[0])
        self.assertNotIn("\n", logs.output[0])

    async def test_metadata_transport_failure_is_reported_without_raw_error(self):
        import httpx

        from frigate.api.stream_diagnostics import collect_diagnostics

        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get.side_effect = httpx.ConnectError("private connection detail")
        with (
            patch(
                "frigate.api.stream_diagnostics.httpx.AsyncClient", return_value=client
            ),
            patch(
                "frigate.api.stream_diagnostics.decode_stream", new_callable=AsyncMock
            ) as decode,
            self.assertLogs("frigate.api.stream_diagnostics", level="WARNING") as logs,
        ):
            result = await collect_diagnostics("ffmpeg", "yard")
        self.assertEqual(result["status"], "unavailable")
        decode.assert_not_awaited()
        self.assertNotIn("private connection detail", logs.output[0])


class TestDecodeProcess(unittest.IsolatedAsyncioTestCase):
    async def test_probe_uses_local_restream_and_counts_decoded_frames(self):
        process = AsyncMock()
        process.returncode = 0
        process.communicate.return_value = (b"frame=1\nframe=50\n", b"")
        with patch("asyncio.create_subprocess_exec", return_value=process) as spawn:
            result = await decode_stream("ffmpeg", "yard?audio=other")
        self.assertEqual(result["decoded_frames"], 50)
        self.assertEqual(result["status"], "healthy")
        self.assertIn(
            "rtsp://127.0.0.1:8554/yard%3Faudio%3Dother", spawn.call_args.args
        )

    async def test_timeout_kills_and_reaps_child(self):
        process = AsyncMock()
        process.returncode = None
        process.kill = unittest.mock.Mock()
        process.communicate.side_effect = [TimeoutError(), (b"", b"")]
        with patch("asyncio.create_subprocess_exec", return_value=process):
            result = await decode_stream("ffmpeg", "yard")
        self.assertEqual(result["status"], "timeout")
        process.kill.assert_called_once()
        self.assertEqual(process.communicate.await_count, 2)

    async def test_cancellation_kills_child_and_propagates(self):
        process = AsyncMock()
        process.returncode = None
        process.kill = unittest.mock.Mock()
        process.communicate.side_effect = [asyncio.CancelledError(), (b"", b"")]
        with patch("asyncio.create_subprocess_exec", return_value=process):
            with self.assertRaises(asyncio.CancelledError):
                await decode_stream("ffmpeg", "yard")
        process.kill.assert_called_once()


class TestDiagnosticRequests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from types import SimpleNamespace

        from frigate.api import stream_diagnostics as diagnostics

        self.diagnostics = diagnostics
        diagnostics._cache.clear()
        diagnostics._inflight.clear()
        self.request = SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=SimpleNamespace(
                    go2rtc=unittest.mock.Mock(), ffmpeg=SimpleNamespace(path="default")
                )
            )
        )
        self.request.app.frigate_config.go2rtc.model_dump.return_value = {
            "streams": {"yard": [], "side": [], "door": []}
        }

    async def test_unknown_stream_cannot_launch_probe(self):
        from fastapi import HTTPException

        with patch.object(self.diagnostics, "collect_diagnostics") as collect:
            with self.assertRaises(HTTPException) as error:
                await self.diagnostics.stream_diagnostics(
                    self.request, "unknown", self.diagnostics.PlaybackFailure()
                )
            self.assertEqual(error.exception.status_code, 404)
            collect.assert_not_called()

    async def test_concurrent_requests_share_probe_and_cache_result(self):
        with patch.object(
            self.diagnostics,
            "collect_diagnostics",
            new_callable=AsyncMock,
            return_value={"id": "reference", "status": "healthy"},
        ) as collect:
            first, second = await asyncio.gather(
                *[
                    self.diagnostics.stream_diagnostics(
                        self.request,
                        "yard",
                        self.diagnostics.PlaybackFailure(reason="startup"),
                    )
                    for _ in range(2)
                ]
            )
            third = await self.diagnostics.stream_diagnostics(
                self.request, "yard", self.diagnostics.PlaybackFailure()
            )
            collect.assert_awaited_once()
            self.assertEqual(first, second)
            self.assertEqual(first, third)
            self.assertFalse(self.diagnostics._inflight)

    async def test_busy_probe_limit_rejects_new_work(self):
        from fastapi import HTTPException

        self.diagnostics._inflight.update({"side": None, "door": None})
        try:
            with self.assertRaises(HTTPException) as error:
                await self.diagnostics.stream_diagnostics(
                    self.request, "yard", self.diagnostics.PlaybackFailure()
                )
            self.assertEqual(error.exception.status_code, 429)
        finally:
            self.diagnostics._inflight.clear()


class TestDiagnosticAuthorization(unittest.TestCase):
    def test_camera_permissions_run_before_diagnostic_probe(self):
        from types import SimpleNamespace

        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from frigate.api.stream_diagnostics import router

        app = FastAPI()
        app.include_router(router)
        app.frigate_config = SimpleNamespace(
            cameras={
                "yard": SimpleNamespace(live=SimpleNamespace(streams={"Main": "yard"})),
                "side": SimpleNamespace(live=SimpleNamespace(streams={"Main": "side"})),
            },
            auth=SimpleNamespace(roles={"limited": ["yard"]}),
            go2rtc=unittest.mock.Mock(),
            ffmpeg=SimpleNamespace(path="default"),
        )
        app.frigate_config.go2rtc.model_dump.return_value = {
            "streams": {"yard": [], "side": []}
        }
        with (
            patch(
                "frigate.api.auth.get_current_user",
                new_callable=AsyncMock,
                return_value={"username": "viewer", "role": "limited"},
            ),
            patch(
                "frigate.api.stream_diagnostics.collect_diagnostics",
                new_callable=AsyncMock,
            ) as probe,
        ):
            with TestClient(app) as client:
                response = client.post(
                    "/go2rtc/streams/side/diagnostics", json={"reason": "startup"}
                )
            self.assertEqual(response.status_code, 403)
            probe.assert_not_called()

    def test_unauthenticated_request_cannot_run_probe(self):
        from fastapi import FastAPI
        from fastapi.responses import JSONResponse
        from fastapi.testclient import TestClient

        from frigate.api.stream_diagnostics import router

        app = FastAPI()
        app.include_router(router)
        with (
            patch(
                "frigate.api.auth.get_current_user",
                new_callable=AsyncMock,
                return_value=JSONResponse(
                    status_code=401, content={"message": "Authentication required"}
                ),
            ),
            patch(
                "frigate.api.stream_diagnostics.collect_diagnostics",
                new_callable=AsyncMock,
            ) as probe,
        ):
            with TestClient(app) as client:
                response = client.post("/go2rtc/streams/yard/diagnostics", json={})
            self.assertEqual(response.status_code, 401)
            probe.assert_not_called()
