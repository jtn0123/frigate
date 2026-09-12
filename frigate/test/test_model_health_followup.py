"""Regression checks for monitoring truth, persistence and camera authorization."""

import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from peewee import DoesNotExist

from frigate.api import app as main_api
from frigate.api import review_audio
from frigate.stats.ai_models import collect_local_models, stats_fresh
from frigate.stats.model_history import read_history, save_sample


class MonitoringTruthTests(unittest.TestCase):
    def test_source_age_and_dead_process_hide_live_metrics(self):
        config = SimpleNamespace(
            detectors={
                "test": SimpleNamespace(model=SimpleNamespace(path=None), type="onnx")
            },
            semantic_search=SimpleNamespace(enabled=False, model="unused"),
            face_recognition=SimpleNamespace(enabled=False),
            lpr=SimpleNamespace(enabled=False),
            cameras={},
        )
        for age, memory, expected in [
            (1000, 20, "stale"),
            (0, None, "unavailable"),
            (0, 20, "loaded"),
        ]:
            stats = {
                "service": {"last_updated": time.time() - age},
                "detectors": {"test": {"pid": 999, "cpu": 35, "inference_speed": 14}},
            }
            with (
                patch("frigate.stats.ai_models.process_memory", return_value=memory),
                patch("frigate.stats.ai_models.audio_models", return_value=([], {})),
            ):
                model = collect_local_models(config, stats)[0][0]
            self.assertEqual(model["status"], expected)
            if expected != "loaded":
                self.assertIsNone(model["cpu_percent"])
                self.assertIsNone(model["latency_ms"])
        self.assertFalse(stats_fresh({}))
        self.assertFalse(stats_fresh({"service": {"last_updated": float("nan")}}))

    def test_history_survives_reader_restart_and_prunes_old_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.sqlite"
            now = int(time.time() // 60) * 60 + 5
            save_sample({"updated": now - 90000, "models": []}, path)
            save_sample({"updated": now, "models": [{"id": "medium"}]}, path)
            save_sample({"updated": now + 1, "models": [{"id": "large"}]}, path)
            samples = read_history(path)
            self.assertEqual(len(samples), 1)
            self.assertEqual(samples[0]["models"][0]["id"], "large")

    def test_metrics_rejects_viewer_before_collection(self):
        app = FastAPI()
        app.frigate_config = SimpleNamespace(
            auth=SimpleNamespace(roles={"admin": {}, "viewer": {}}),
            proxy=SimpleNamespace(separator=","),
        )
        app.include_router(main_api.router)
        with (
            TestClient(app) as client,
            patch.object(main_api, "update_metrics") as update,
        ):
            for headers in ({}, {"remote-role": "viewer"}):
                self.assertEqual(
                    client.get("/metrics", headers=headers).status_code, 403
                )
            update.assert_not_called()
            app.stats_emitter = SimpleNamespace(get_latest_stats=lambda: {})
            with (
                patch.object(main_api.Event, "select") as select,
                patch.object(
                    main_api, "get_metrics", return_value=(b"# test\n", "text/plain")
                ),
            ):
                select.return_value.group_by.return_value.dicts.return_value = []
                self.assertEqual(
                    client.get(
                        "/metrics", headers={"remote-role": "admin"}
                    ).status_code,
                    200,
                )
            update.assert_called_once()


class AudioAccessTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.frigate_config = SimpleNamespace(
            auth=SimpleNamespace(roles={"limited": ["front"]}),
            proxy=SimpleNamespace(separator=","),
            cameras={"front": {}, "back": {}},
        )
        self.app.include_router(review_audio.router)
        self.client = TestClient(self.app)

    def test_permissions_checked_before_file_access(self):
        with (
            patch.object(
                review_audio.ReviewSegment,
                "get",
                return_value=SimpleNamespace(camera="back"),
            ),
            patch.object(review_audio, "read_results") as read,
        ):
            self.assertEqual(self.client.get("/review/test/audio").status_code, 401)
            self.assertEqual(
                self.client.get(
                    "/review/test/audio",
                    headers={"remote-role": "limited", "remote-user": "viewer"},
                ).status_code,
                403,
            )
            read.assert_not_called()
        with (
            patch.object(
                review_audio.ReviewSegment,
                "get",
                return_value=SimpleNamespace(camera="front"),
            ),
            patch.object(
                review_audio,
                "read_results",
                return_value={"status": "available", "chunks": []},
            ),
        ):
            self.assertEqual(
                self.client.get(
                    "/review/test/audio",
                    headers={"remote-role": "limited", "remote-user": "viewer"},
                ).status_code,
                200,
            )
        with patch.object(review_audio.ReviewSegment, "get", side_effect=DoesNotExist):
            self.assertEqual(
                self.client.get(
                    "/review/missing/audio",
                    headers={"remote-role": "admin", "remote-user": "admin"},
                ).status_code,
                404,
            )

    def test_wrong_camera_and_malformed_results_never_leak(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(review_audio, "RESULTS", Path(directory)),
        ):
            path = Path(directory) / (hashlib.sha256(b"test").hexdigest() + ".json")
            for text in (
                '{"review_id":"test","camera":"back","chunks":[{"text":"private"}]}',
                "[1]",
                "{",
                " " * (1024 * 1024 + 1),
            ):
                path.write_text(text)
                response = review_audio.read_results("test", "front")
                self.assertEqual(response["status"], "unavailable")
                self.assertNotIn("private", json.dumps(response))


class BackgroundCollectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_sampler_persists_without_any_browser_request(self):
        import asyncio

        from frigate.api import ai_models as api

        app = SimpleNamespace(
            state=SimpleNamespace(),
            frigate_config=SimpleNamespace(),
            stats_emitter=SimpleNamespace(
                get_latest_stats=lambda: {"service": {"last_updated": time.time()}}
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.sqlite"
            with (
                patch.object(
                    api,
                    "collect_local_models",
                    return_value=([], {"status": "connected"}),
                ),
                patch.object(api, "collect_ollama_models", return_value=[]),
                patch.object(api, "read_server_pressure", return_value={}),
                patch.object(
                    api, "save_sample", side_effect=lambda data: save_sample(data, path)
                ),
                patch.object(api.asyncio, "sleep", side_effect=asyncio.CancelledError),
            ):
                with self.assertRaises(asyncio.CancelledError):
                    await api.model_sampler(app)
            self.assertEqual(len(read_history(path)), 1)
            self.assertEqual(app.state.ai_models_cache[1].history_status, "connected")


class PrometheusModelTests(unittest.TestCase):
    def test_unknown_measurements_are_omitted_and_stale_samples_marked(self):
        from frigate.stats.model_prometheus import model_metrics

        sample = {
            "updated": time.time(),
            "models": [
                {
                    "id": "medium",
                    "status": "loaded",
                    "resource_scope": "process",
                    "cpu_percent": 0,
                    "ram_bytes": None,
                }
            ],
            "audio": {"status": "stale", "pending": 9},
        }
        text = model_metrics(sample).decode()
        self.assertIn(
            'frigate_ai_model_cpu_percent{model="medium",scope="process"} 0.0', text
        )
        self.assertNotIn("frigate_ai_model_ram_bytes{", text)
        self.assertNotIn("frigate_ai_queue_pending", text)
        sample["updated"] -= 1000
        text = model_metrics(sample).decode()
        self.assertIn("frigate_ai_sample_fresh 0.0", text)
        self.assertNotIn('model="medium"', text)
