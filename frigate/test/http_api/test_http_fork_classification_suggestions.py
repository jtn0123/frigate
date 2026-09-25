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
        self.assertEqual(body["omitted"], 0)
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
        missing = client.post(
            "/classification/vehicle_type/suggestions/confirm",
            json={
                "event_id": "evt-1",
                "category": "van",
                "training_files": ["evt-1-1.0-unknown-0.0.webp", "nope.webp"],
            },
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(
            missing.json()["message"], "One of the train images no longer exists"
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

    def test_confirming_a_filed_group_again_says_already_accepted(self):
        client = AuthTestClient(self.app)
        body = {
            "event_id": "evt-1",
            "category": "van",
            "training_files": [
                "evt-1-1.0-unknown-0.0.webp",
                "evt-1-2.0-unknown-0.0.webp",
            ],
            "suggested_category": "van",
        }
        url = "/classification/vehicle_type/suggestions/confirm"
        self.assertEqual(client.post(url, json=body).status_code, 200)

        again = client.post(url, json=body)

        self.assertEqual(again.status_code, 404)
        self.assertEqual(
            again.json(),
            {"success": False, "message": "already accepted", "moved": []},
        )
        self.assertEqual(
            len(suggest.read_provenance(self.clips, "vehicle_type")),
            1,
            "nothing recorded for the second click",
        )

    def test_bulk_confirm_is_recorded_and_kept_out_of_the_rate(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)
        url = "/classification/vehicle_type/suggestions/confirm"
        for training_file, bulk in (
            ("evt-1-1.0-unknown-0.0.webp", True),
            ("evt-1-2.0-unknown-0.0.webp", False),
        ):
            response = client.post(
                url,
                json={
                    "event_id": "evt-1",
                    "category": "van",
                    "training_files": [training_file],
                    "source": "text",
                    "suggested_category": "van",
                    "bulk": bulk,
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
        entries = suggest.read_provenance(self.clips, "vehicle_type")
        self.assertEqual([entry["bulk"] for entry in entries], [True, False])

        report = client.get("/classification/vehicle_type/suggestions/report").json()

        self.assertEqual((report["total"], report["accepted"]), (1, 1))
        self.assertEqual(report["bulk_accepted"], 1)
        self.assertEqual(report["classes"]["van"]["bulk_accepted"], 1)
        self.assertEqual(report["classes"]["van"]["total"], 1)

    def test_undo_moves_an_accepted_group_back_and_leaves_the_rate(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)
        train_files = ["evt-1-1.0-unknown-0.0.webp", "evt-1-2.0-unknown-0.0.webp"]
        moved = client.post(
            "/classification/vehicle_type/suggestions/confirm",
            json={
                "event_id": "evt-1",
                "category": "van",
                "training_files": train_files,
                "source": "text",
                "suggested_category": "van",
            },
        ).json()["moved"]
        url = "/classification/vehicle_type/suggestions/undo"

        response = client.post(
            url,
            json={
                "event_id": "evt-1",
                "category": "van",
                "files": [*moved, "gone.png"],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {"success": True, "message": "Moved 2 image(s) back.", "restored": 2},
        )
        self.assertEqual(sorted(os.listdir(self.train)), train_files)
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "van")
        self.assertEqual(os.listdir(dataset), [])
        undo = suggest.read_provenance(self.clips, "vehicle_type")[-1]
        self.assertTrue(undo["undo"])
        self.assertEqual((undo["event_id"], undo["category"]), ("evt-1", "van"))
        self.assertEqual(undo["files"], moved)
        report = client.get("/classification/vehicle_type/suggestions/report").json()
        self.assertEqual((report["total"], report["undone"]), (0, 1))
        event = client.get("/classification/suggestions/event/evt-1").json()
        self.assertIsNone(event["models"][0]["filed"], "undone means not filed")
        self.assertEqual(event["models"][0]["training_files"], train_files)

        again = client.post(
            url, json={"event_id": "evt-1", "category": "van", "files": moved}
        )
        self.assertEqual(again.json()["restored"], 0)
        for bad in (
            {"event_id": "evt-1", "category": "..", "files": ["a.png"]},
            {"event_id": "evt-1", "category": "van", "files": ["../a.png"]},
            {"event_id": "evt-1", "category": "van", "files": ["sub/a.png"]},
            {"event_id": "../evt-1", "category": "van", "files": ["a.png"]},
        ):
            self.assertEqual(client.post(url, json=bad).status_code, 400, bad)
        self.assertEqual(
            client.post(
                url, json={"event_id": "evt-1", "category": "van", "files": []}
            ).status_code,
            422,
        )
        self.assertEqual(
            client.post(
                "/classification/nope/suggestions/undo",
                json={"event_id": "evt-1", "category": "van", "files": ["a.png"]},
            ).status_code,
            404,
        )

    def test_ids_past_the_cap_are_counted_as_omitted(self):
        self._event("evt-1", "A white van is parked.")
        ids = ["evt-1", *(f"x-{i}" for i in range(suggest.MAX_EVENTS + 4)), "evt-1"]
        client = AuthTestClient(self.app)
        body = client.get(
            "/classification/vehicle_type/suggestions", params={"ids": ",".join(ids)}
        ).json()
        self.assertEqual(suggest.MAX_EVENTS, 400)
        self.assertEqual(body["omitted"], 5, "duplicates are not counted")
        self.assertEqual(set(body["suggestions"]), {"evt-1"})

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
                "bulk_accepted": 0,
                "undone": 0,
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
                "dataset": {
                    "classes": {"none": 0, "suv": 0, "van": 0},
                    "empty": ["none", "suv", "van"],
                    "largest": None,
                    "smallest": None,
                    "ratio": None,
                    "lopsided": False,
                },
                "training": {
                    "has_trained": False,
                    "last_training_date": None,
                    "current_images": 0,
                    "new_images": 0,
                },
                "recent_auto_filed": [],
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
        self.assertEqual(report["dataset"]["classes"], {"none": 0, "suv": 1, "van": 1})
        self.assertEqual(report["training"]["new_images"], 2)
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
        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/spot-check",
                json={"event_id": "evt-1", "category": "van", "keep": True},
                headers=headers,
            ).status_code,
            403,
        )
        self.assertEqual(
            client.post(
                "/classification/vehicle_type/suggestions/undo",
                json={"event_id": "evt-1", "category": "van", "files": ["a.png"]},
                headers=headers,
            ).status_code,
            403,
        )

    def test_suggestions_flag_train_images_too_small_to_train_on(self):
        self._event("evt-1", "A white van is parked.")
        self._event("evt-2", "Nothing to see.")
        client = AuthTestClient(self.app)
        body = client.get(
            "/classification/vehicle_type/suggestions?ids=evt-1,evt-2"
        ).json()
        self.assertEqual(
            body["too_small"],
            {"evt-1": ["evt-1-1.0-unknown-0.0.webp", "evt-1-2.0-unknown-0.0.webp"]},
            "8 px test crops, listed only for events with a draft",
        )
        model = client.get("/classification/suggestions/event/evt-1").json()["models"][
            0
        ]
        self.assertEqual(model["too_small"], model["training_files"])

    def test_spot_check_keeps_or_removes_auto_filed_images(self):
        self._event("evt-1", "A white van is parked.")
        client = AuthTestClient(self.app)
        dataset = os.path.join(self.clips, "vehicle_type", "dataset", "van")
        image = np.zeros((8, 8, 3), dtype=np.uint8)
        for name in ("van-1.png", "van-2.png"):
            cv2.imwrite(os.path.join(dataset, name), image)
        suggest.record_confirmation(
            self.clips,
            "vehicle_type",
            {
                "event_id": "evt-1",
                "camera": "front_door",
                "category": "van",
                "suggested_category": "van",
                "source": "jev",
                "score": 0.95,
                "accepted": True,
                "auto": True,
                "files": ["van-1.png", "van-2.png"],
            },
        )
        report = client.get("/classification/vehicle_type/suggestions/report").json()
        self.assertEqual(len(report["recent_auto_filed"]), 1)
        group = report["recent_auto_filed"][0]
        self.assertEqual(group["files"], ["van-1.png", "van-2.png"])
        self.assertEqual(group["camera"], "front_door")

        url = "/classification/vehicle_type/suggestions/spot-check"
        response = client.post(
            url,
            json={
                "event_id": "evt-1",
                "category": "van",
                "files": ["van-1.png", "van-1.png"],
                "keep": False,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["removed"], ["van-1.png"])
        self.assertEqual(os.listdir(dataset), ["van-2.png"])
        report = client.get("/classification/vehicle_type/suggestions/report").json()
        self.assertEqual(
            report["recent_auto_filed"], [], "checked groups leave the list"
        )
        self.assertEqual((report["total"], report["accepted"]), (1, 0))

        response = client.post(
            url,
            json={"event_id": "evt-9", "category": "van", "files": [], "keep": True},
        )
        self.assertEqual(
            response.json(), {"success": True, "message": "Kept.", "removed": []}
        )
        self.assertEqual(
            client.post(
                url, json={"event_id": "e", "category": "..", "keep": True}
            ).status_code,
            400,
        )
        self.assertEqual(
            client.post(
                url,
                json={
                    "event_id": "e",
                    "category": "van",
                    "files": [""],
                    "keep": False,
                },
            ).status_code,
            400,
        )
        self.assertEqual(
            client.post(
                "/classification/nope/suggestions/spot-check",
                json={"event_id": "e", "category": "van", "keep": True},
            ).status_code,
            404,
        )


class TestHttpForkAttributePassthrough(BaseTestHttp):
    """Fork I53: custom attribute verdicts survive the explore and search endpoints."""

    def setUp(self):
        super().setUp([Event])
        self.minimal_config["classification"] = {
            "custom": {
                "vehicle_type": {
                    "object_config": {
                        "objects": ["car"],
                        "classification_type": "attribute",
                    }
                },
                "dog_breed": {"object_config": {"objects": ["dog"]}},
            }
        }
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def test_attribute_keys_come_from_attribute_models_only(self):
        from frigate.fork.event_data_keys import custom_attribute_keys

        self.assertEqual(
            custom_attribute_keys(self.app.frigate_config),
            ["vehicle_type", "vehicle_type_score"],
        )

    def test_explore_returns_the_attribute_verdict(self):
        Event.insert(
            id="evt-1",
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
            data={
                "top_score": 0.9,
                "vehicle_type": "van",
                "vehicle_type_score": 0.93,
                "private": "stays behind",
            },
        ).execute()
        client = AuthTestClient(self.app)
        events = client.get("/events/explore").json()
        self.assertEqual(len(events), 1)
        self.assertEqual(
            events[0]["data"],
            {"top_score": 0.9, "vehicle_type": "van", "vehicle_type_score": 0.93},
        )
