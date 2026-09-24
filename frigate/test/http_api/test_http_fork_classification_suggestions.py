"""HTTP tests for suggested dataset classes (fork I41)."""

import json
import os
import shutil
import tempfile
from typing import Any
from unittest.mock import patch

import cv2
import numpy as np

from frigate.api import fork_classification_suggestions as api
from frigate.fork import classification_suggestions as suggest
from frigate.models import Event
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


class TestHttpForkClassificationSuggestions(BaseTestHttp):
    def setUp(self):
        super().setUp([Event])
        self.root = tempfile.mkdtemp()
        self.clips = os.path.join(self.root, "clips")
        self.train = os.path.join(self.clips, "vehicle_type", "train")
        os.makedirs(self.train)
        for name in ("van", "suv", "none"):
            os.makedirs(os.path.join(self.clips, "vehicle_type", "dataset", name))
        image = np.zeros((8, 8, 3), dtype=np.uint8)
        for name in ("evt-1-1.0-unknown-0.0.webp", "evt-1-2.0-unknown-0.0.webp"):
            cv2.imwrite(os.path.join(self.train, name), image)

        self.minimal_config["database"] = {
            "path": os.path.join(self.root, "frigate.db")
        }
        self.minimal_config["classification"] = {
            "custom": {"vehicle_type": {"object_config": {"objects": ["car"]}}}
        }
        self.app = super().create_app()
        clips_patch = patch.object(api, "CLIPS_DIR", self.clips)
        clips_patch.start()
        self.addCleanup(clips_patch.stop)
        key_patch = patch.dict(os.environ, {"FRIGATE_JEV_API_KEY": ""})
        key_patch.start()
        self.addCleanup(key_patch.stop)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _event(self, id: str, description: str | None) -> None:
        data: dict[str, Any] = {"top_score": 0.9}
        if description is not None:
            data["description"] = description
        Event.insert(
            id=id,
            label="car",
            camera="front_door",
            start_time=1.0,
            end_time=2.0,
            top_score=0.9,
            false_positive=False,
            zones=[],
            thumbnail="",
            has_clip=False,
            has_snapshot=False,
            region=[],
            box=[],
            area=0,
            data=data,
        ).execute()

    def test_unknown_model_is_404(self):
        client = AuthTestClient(self.app)
        self.assertEqual(
            client.get("/classification/nope/suggestions?ids=x").status_code, 404
        )
        self.assertEqual(
            client.post(
                "/classification/nope/suggestions/confirm",
                json={"event_id": "x", "category": "van", "training_files": ["a"]},
            ).status_code,
            404,
        )

    def test_suggestions_come_from_descriptions_without_jev(self):
        self._event("evt-1", "A white van is parked in the driveway.")
        self._event("evt-2", "A person walks past.")
        client = AuthTestClient(self.app)

        response = client.get(
            "/classification/vehicle_type/suggestions?ids=evt-1,evt-2,evt-1,missing"
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["model"], "vehicle_type")
        self.assertEqual(body["classes"], ["none", "suv", "van"])
        self.assertEqual(
            body["jev"],
            {
                "enabled": False,
                "configured": False,
                "used_today": 0,
                "daily_request_limit": 200,
            },
        )
        self.assertEqual(set(body["suggestions"]), {"evt-1", "evt-2"})
        self.assertEqual(body["suggestions"]["evt-1"]["suggestion"]["category"], "van")
        self.assertEqual(body["suggestions"]["evt-1"]["jev_status"], "disabled")
        self.assertIsNone(body["suggestions"]["evt-2"]["suggestion"])

    def test_jev_enabled_without_a_key_stays_local(self):
        self._event("evt-1", "A white van is parked.")
        self.app.frigate_config.classification.suggestions.jev.enabled = True
        client = AuthTestClient(self.app)

        body = client.get("/classification/vehicle_type/suggestions?ids=evt-1").json()

        self.assertEqual(
            body["jev"],
            {
                "enabled": True,
                "configured": False,
                "used_today": 0,
                "daily_request_limit": 200,
            },
        )
        self.assertEqual(body["suggestions"]["evt-1"]["jev_status"], "disabled")
        self.assertEqual(body["suggestions"]["evt-1"]["suggestion"]["source"], "text")

    def test_jev_is_asked_once_per_description_and_cached(self):
        self._event("evt-1", "A gray crossover pulls in.")
        self.app.frigate_config.classification.suggestions.jev.enabled = True
        calls: list[dict[str, Any]] = []

        def fake_ask(session, url, key, timeout):
            async def ask(request):
                calls.append({"url": url, "key": key, "request": request})
                names = [*suggest.candidate_classes(["none", "suv", "van"]), "unknown"]
                probabilities = {n: 0.0 for n in names}
                probabilities["suv"] = 0.97
                probabilities["unknown"] = 0.03
                return {
                    "answers": {
                        "category": {
                            "type": "choice",
                            "choice": "suv",
                            "probabilities": probabilities,
                        }
                    }
                }

            return ask

        with (
            patch.dict(os.environ, {"FRIGATE_JEV_API_KEY": "secret"}),
            patch.object(api, "make_ask", fake_ask),
        ):
            client = AuthTestClient(self.app)
            first = client.get(
                "/classification/vehicle_type/suggestions?ids=evt-1"
            ).json()
            second = client.get(
                "/classification/vehicle_type/suggestions?ids=evt-1"
            ).json()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["key"], "secret")
        self.assertEqual(calls[0]["url"], "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(
            calls[0]["request"]["state"], {"description": "A gray crossover pulls in."}
        )
        for body in (first, second):
            self.assertTrue(body["jev"]["configured"])
            self.assertEqual(body["jev"]["used_today"], 1)
            self.assertEqual(
                body["suggestions"]["evt-1"]["suggestion"]["category"], "suv"
            )
            self.assertEqual(
                body["suggestions"]["evt-1"]["suggestion"]["source"], "jev"
            )
            self.assertEqual(body["suggestions"]["evt-1"]["suggestion"]["score"], 0.97)
        self.assertTrue(
            os.path.isfile(os.path.join(self.root, "classification-suggestions.sqlite"))
        )

    def test_confirm_moves_the_files_and_records_provenance(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)

        response = client.post(
            "/classification/vehicle_type/suggestions/confirm",
            json={
                "event_id": "evt-1",
                "category": "van",
                "training_files": [
                    "evt-1-1.0-unknown-0.0.webp",
                    "evt-1-2.0-unknown-0.0.webp",
                ],
                "source": "text",
                "suggested_category": "van",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(len(body["moved"]), 2)
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "van")
        self.assertEqual(sorted(os.listdir(dataset)), sorted(body["moved"]))
        self.assertEqual(os.listdir(self.train), [])
        with open(
            os.path.join(self.clips, "vehicle_type", suggest.PROVENANCE_FILE)
        ) as f:
            entry = json.loads(f.readline())
        self.assertEqual(entry["event_id"], "evt-1")
        self.assertEqual(entry["camera"], "front_door")
        self.assertEqual(entry["category"], "van")
        self.assertEqual(entry["source"], "text")
        self.assertTrue(entry["accepted"])
        self.assertEqual(
            entry["description_sha256"],
            suggest.description_sha256("A white van is parked."),
        )
        self.assertEqual(entry["files"], body["moved"])

    def test_confirm_with_an_edited_class_is_recorded_as_not_accepted(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)

        response = client.post(
            "/classification/vehicle_type/suggestions/confirm",
            json={
                "event_id": "evt-1",
                "category": "suv",
                "training_files": ["evt-1-1.0-unknown-0.0.webp"],
                "source": "text",
                "suggested_category": "van",
            },
        )

        self.assertEqual(response.status_code, 200)
        with open(
            os.path.join(self.clips, "vehicle_type", suggest.PROVENANCE_FILE)
        ) as f:
            entry = json.loads(f.readline())
        self.assertFalse(entry["accepted"])
        self.assertEqual(entry["suggested_category"], "van")

    def test_confirm_rejects_bad_categories_and_missing_files(self):
        client = AuthTestClient(self.app)
        base = {"event_id": "evt-1", "training_files": ["evt-1-1.0-unknown-0.0.webp"]}

        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/confirm",
                json={**base, "category": "none"},
            ).status_code,
            400,
        )
        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/confirm",
                json={**base, "category": ".."},
            ).status_code,
            400,
        )
        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/confirm",
                json={
                    "event_id": "evt-1",
                    "category": "van",
                    "training_files": ["nope.webp"],
                },
            ).status_code,
            404,
        )
        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/confirm",
                json={
                    "event_id": "evt-1",
                    "category": "van",
                    "training_files": [".."],
                },
            ).status_code,
            400,
        )
        self.assertEqual(len(os.listdir(self.train)), 2)
        self.assertFalse(
            os.path.exists(
                os.path.join(self.clips, "vehicle_type", suggest.PROVENANCE_FILE)
            )
        )

    def test_event_suggestions_cover_every_model_for_the_label(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)
        self.assertEqual(
            client.get("/classification/suggestions/event/missing").status_code, 404
        )
        body = client.get("/classification/suggestions/event/evt-1").json()
        self.assertEqual(body["event_id"], "evt-1")
        self.assertEqual(len(body["models"]), 1)
        model = body["models"][0]
        self.assertEqual(model["model"], "vehicle_type")
        self.assertEqual(model["classes"], ["none", "suv", "van"])
        self.assertEqual(model["suggestion"]["suggestion"]["category"], "van")
        self.assertEqual(
            model["training_files"],
            ["evt-1-1.0-unknown-0.0.webp", "evt-1-2.0-unknown-0.0.webp"],
        )
        self.assertIsNone(model["model_said"])
        self.assertIsNone(model["filed"])

        Event.update(sub_label="SUV").where(Event.id == "evt-1").execute()
        client.post(
            "/classification/vehicle_type/suggestions/confirm",
            json={
                "event_id": "evt-1",
                "category": "van",
                "training_files": ["evt-1-1.0-unknown-0.0.webp"],
                "source": "text",
                "score": None,
                "suggested_category": "van",
            },
        )
        model = client.get("/classification/suggestions/event/evt-1").json()["models"][
            0
        ]
        self.assertEqual(model["model_said"], "suv")
        self.assertEqual(model["filed"], {"category": "van", "auto": False})
        self.assertEqual(model["training_files"], ["evt-1-2.0-unknown-0.0.webp"])

        self._event("evt-dog", "A dog.")
        Event.update(label="dog").where(Event.id == "evt-dog").execute()
        self.assertEqual(
            client.get("/classification/suggestions/event/evt-dog").json()["models"],
            [],
        )

    def test_event_suggestions_need_an_admin(self):
        self._event("evt-1", "A white van is parked.")
        headers = {"remote-user": "viewer", "remote-role": "viewer"}
        self.assertEqual(
            AuthTestClient(self.app)
            .get("/classification/suggestions/event/evt-1", headers=headers)
            .status_code,
            403,
        )

    def test_report_summarizes_the_recorded_confirmations(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)
        self.assertEqual(
            client.get("/classification/vehicle_type/suggestions/report").json(),
            {
                "model": "vehicle_type",
                "total": 0,
                "accepted": 0,
                "rate": None,
                "auto_filed": 0,
                "sources": {},
                "classes": {},
                "cameras": {},
                "first_time": None,
                "last_time": None,
                "model_check": {
                    "total": 0,
                    "accepted": 0,
                    "rate": None,
                    "classes": {},
                    "recent_disagreements": [],
                },
            },
        )
        for category, training_file in (
            ("van", "evt-1-1.0-unknown-0.0.webp"),
            ("suv", "evt-1-2.0-unknown-0.0.webp"),
        ):
            client.post(
                "/classification/vehicle_type/suggestions/confirm",
                json={
                    "event_id": "evt-1",
                    "category": category,
                    "training_files": [training_file],
                    "source": "jev",
                    "score": 0.95,
                    "suggested_category": "van",
                },
            )

        report = client.get("/classification/vehicle_type/suggestions/report").json()

        self.assertEqual((report["total"], report["accepted"]), (2, 1))
        self.assertEqual(report["sources"]["jev"]["rate"], 0.5)
        self.assertEqual(report["classes"]["van"]["corrected_to"], {"suv": 1})
        self.assertEqual(report["cameras"]["front_door"]["total"], 2)
        self.assertIsNotNone(report["first_time"])
        self.assertEqual(
            client.get("/classification/nope/suggestions/report").status_code, 404
        )

    def test_viewer_cannot_read_or_confirm(self):
        client = AuthTestClient(self.app)
        headers = {"remote-user": "viewer", "remote-role": "viewer"}
        self.assertEqual(
            client.get(
                "/classification/vehicle_type/suggestions?ids=x", headers=headers
            ).status_code,
            403,
        )
        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/confirm",
                json={"event_id": "evt-1", "category": "van", "training_files": ["a"]},
                headers=headers,
            ).status_code,
            403,
        )
        self.assertEqual(
            client.get(
                "/classification/vehicle_type/suggestions/report", headers=headers
            ).status_code,
            403,
        )
