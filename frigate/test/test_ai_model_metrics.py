"""Model telemetry must remain honest, bounded, and free of event contents."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from frigate.api import ai_models as api
from frigate.stats import ai_models


class ModelEndpointTests(unittest.TestCase):
    def test_admin_gate_precedes_collection_and_success_is_cached(self):
        app = FastAPI()
        app.frigate_config = SimpleNamespace(
            proxy=SimpleNamespace(separator=","),
            auth=SimpleNamespace(roles={"admin": {}, "viewer": {}}),
        )
        app.stats_emitter = SimpleNamespace(get_latest_stats=dict)
        app.include_router(api.router)
        client = TestClient(app)
        with (
            patch.object(
                api,
                "collect_local_models",
                return_value=([], {"status": "not_connected"}),
            ) as local,
            patch.object(api, "collect_ollama_models", return_value=[]) as remote,
        ):
            self.assertEqual(client.get("/ai/models").status_code, 403)
            self.assertEqual(
                client.get("/ai/models", headers={"remote-role": "viewer"}).status_code,
                403,
            )
            local.assert_not_called()
            first = client.get("/ai/models", headers={"remote-role": "admin"})
            self.assertEqual(first.status_code, 200)
            second = client.get("/ai/models", headers={"remote-role": "admin"})
            self.assertEqual(first.json(), second.json())
            local.assert_called_once()
            remote.assert_called_once()


class AudioMetricsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "models.json"
        self.path_patch = patch.object(ai_models, "AUDIO_TELEMETRY", self.path)
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.directory.cleanup()

    def test_missing_telemetry_does_not_break_other_models(self):
        self.assertEqual(ai_models.audio_models(), ([], {"status": "not_connected"}))

    def test_sanitizes_private_fields_and_invalid_measurements(self):
        self.path.write_text(
            json.dumps(
                {
                    "updated": time.time(),
                    "transcript": "private words",
                    "queue": {"pending": 2},
                    "pause_reason": "private words",
                    "models": {
                        "medium": {
                            "status": "busy",
                            "ram_bytes": 100,
                            "cpu_percent": float("nan"),
                            "translation": "private words",
                            "latency_ms": -1,
                        }
                    },
                }
            )
        )
        models, queue = ai_models.audio_models()
        self.assertEqual(models[0]["ram_bytes"], 100)
        self.assertIsNone(models[0]["cpu_percent"])
        self.assertIsNone(models[0]["latency_ms"])
        self.assertEqual(queue["pending"], 2)
        self.assertNotIn("private words", json.dumps([models, queue]))

    def test_stale_worker_never_looks_loaded_or_reports_current_usage(self):
        self.path.write_text(
            json.dumps(
                {
                    "updated": time.time() - 100,
                    "models": {
                        "medium": {
                            "status": "busy",
                            "ram_bytes": 100,
                            "cpu_percent": 200,
                            "disk_bytes": 123,
                        }
                    },
                }
            )
        )
        models, queue = ai_models.audio_models()
        self.assertEqual(queue["status"], "stale")
        self.assertEqual(models[0]["status"], "stale")
        self.assertIsNone(models[0]["ram_bytes"])
        self.assertEqual(models[0]["disk_bytes"], 123)

    def test_malformed_and_oversized_files_are_bounded(self):
        for text in ("[]", "{", " " * 65537):
            self.path.write_text(text)
            self.assertEqual(ai_models.audio_models(), ([], {"status": "invalid"}))


class OllamaMetricsTests(unittest.IsolatedAsyncioTestCase):
    async def test_allocation_is_not_mislabeled_as_ram(self):
        provider = SimpleNamespace(
            provider="ollama", model="test", base_url="http://ollama", api_key="secret"
        )
        config = SimpleNamespace(genai={"local": provider})
        requests = []

        def handler(request):
            requests.append(request)
            model = {
                "name": "test:latest",
                "size": 900,
                "size_vram": 700,
                "context_length": 4096,
            }
            return httpx.Response(200, json={"models": [model]})

        client = httpx.AsyncClient
        with patch.object(
            ai_models.httpx,
            "AsyncClient",
            lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs),
        ):
            rows = await ai_models.collect_ollama_models(config)
        self.assertEqual(rows[0]["gpu_memory_bytes"], 700)
        self.assertNotIn("ram_bytes", rows[0])
        self.assertEqual(rows[0]["status"], "loaded")
        self.assertEqual(rows[0]["disk_bytes"], 900)
        self.assertNotIn("secret", json.dumps(rows))
        self.assertEqual({r.method for r in requests}, {"GET"})

    async def test_provider_failure_is_visible_without_failing_inventory(self):
        config = SimpleNamespace(
            genai={
                "local": SimpleNamespace(
                    provider="ollama",
                    model="test",
                    base_url="http://ollama",
                    api_key=None,
                )
            }
        )
        client = httpx.AsyncClient
        with patch.object(
            ai_models.httpx,
            "AsyncClient",
            lambda **kwargs: client(
                transport=httpx.MockTransport(lambda _: httpx.Response(503)), **kwargs
            ),
        ):
            rows = await ai_models.collect_ollama_models(config)
        self.assertEqual(rows[0]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
