"""HTTP tests for the event mutation, Frigate+ and trigger endpoints (fork D67)."""

import base64
import os
import shutil
import tempfile
from datetime import datetime
from unittest.mock import MagicMock, Mock, patch

import numpy as np

from frigate.comms.event_metadata_updater import (
    EventMetadataPublisher,
    EventMetadataTypeEnum,
)
from frigate.models import Event, Recordings, ReviewSegment, Timeline, Trigger
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_BOX_DATA = {
    "type": "object",
    "box": [0.1, 0.1, 0.2, 0.2],
    "region": [0.0, 0.0, 0.5, 0.5],
    "score": None,
    "top_score": 0.8,
}


class _EventHttpTestCase(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Timeline, Trigger])
        self.publisher = Mock(spec=EventMetadataPublisher)
        self.app = super().create_app(event_metadata_publisher=self.publisher)
        self.tmp_dir = tempfile.mkdtemp()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        shutil.rmtree(self.tmp_dir, ignore_errors=True)
        super().tearDown()

    def published(self, topic: EventMetadataTypeEnum) -> list[tuple]:
        return [
            c.args[0]
            for c in self.publisher.publish.call_args_list
            if c.args[1] == topic.value
        ]


class TestEventGetAndRetain(_EventHttpTestCase):
    def test_get_event_by_id(self):
        self.insert_mock_event("e1")
        with AuthTestClient(self.app) as client:
            found = client.get("/events/e1")
            missing = client.get("/events/missing")

        assert found.status_code == 200
        assert found.json()["id"] == "e1"
        assert missing.status_code == 404

    def test_retain_and_unretain(self):
        self.insert_mock_event("e1")
        with AuthTestClient(self.app) as client:
            retained = client.post("/events/e1/retain")
            assert retained.status_code == 200
            assert Event.get_by_id("e1").retain_indefinitely is True

            released = client.delete("/events/e1/retain")
            assert released.status_code == 200
            assert released.json()["message"] == "Event e1 un-retained"
            assert Event.get_by_id("e1").retain_indefinitely is False

            assert client.post("/events/missing/retain").status_code == 404
            assert client.delete("/events/missing/retain").status_code == 404


class TestEventPlus(_EventHttpTestCase):
    def setUp(self):
        super().setUp()
        self.plus = self.app.frigate_config.plus_api
        patcher = patch.object(type(self.plus), "is_active", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _snapshot(self, image=None, clean=True):
        if image is None:
            image = np.zeros((4, 4, 3), dtype=np.uint8)
        return patch(
            "frigate.api.event.load_event_snapshot_image",
            return_value=(image, clean),
        )

    def test_plus_requires_api_key(self):
        with patch.object(type(self.plus), "is_active", return_value=False):
            with AuthTestClient(self.app) as client:
                plus = client.post("/events/e1/plus")
                false_positive = client.put("/events/e1/false_positive")

        assert plus.status_code == 400
        assert "PLUS_API_KEY" in plus.json()["message"]
        assert false_positive.status_code == 400

    def test_plus_missing_event(self):
        with AuthTestClient(self.app) as client:
            assert client.post("/events/missing/plus").status_code == 404
            assert client.put("/events/missing/false_positive").status_code == 404

    def test_plus_rejects_in_progress_and_already_submitted(self):
        now = datetime.now().timestamp()
        self.insert_mock_event("live", start_time=now, data=_BOX_DATA)
        Event.update(end_time=None).where(Event.id == "live").execute()
        self.insert_mock_event("sent", data=_BOX_DATA)
        Event.update(plus_id="plus-1").where(Event.id == "sent").execute()

        with AuthTestClient(self.app) as client:
            live = client.post("/events/live/plus")
            sent = client.post("/events/sent/plus")

        assert live.status_code == 400
        assert "in-progress" in live.json()["message"]
        assert sent.status_code == 400
        assert sent.json()["message"] == "Already submitted to plus"

    def test_plus_snapshot_failures(self):
        self.insert_mock_event("e1", data=_BOX_DATA)
        with AuthTestClient(self.app) as client:
            with patch(
                "frigate.api.event.load_event_snapshot_image",
                side_effect=OSError("disk"),
            ):
                broken = client.post("/events/e1/plus")
            with self._snapshot(clean=False):
                not_clean = client.post("/events/e1/plus")

        assert broken.json()["message"] == "Unable to load clean snapshot for event"
        assert not_clean.json()["message"] == "Unable to find clean snapshot for event"

    def test_plus_upload_and_annotation(self):
        self.insert_mock_event("e1", data=_BOX_DATA)
        with (
            self._snapshot(),
            patch.object(self.plus, "upload_image", return_value="plus-9") as upload,
            patch.object(self.plus, "add_annotation") as annotate,
        ):
            with AuthTestClient(self.app) as client:
                response = client.post("/events/e1/plus", json={})

        assert response.status_code == 200
        assert response.json() == {"success": True, "plus_id": "plus-9"}
        assert upload.call_args.args[1] == "front_door"
        annotate.assert_called_once_with("plus-9", _BOX_DATA["box"], "Mock")
        assert Event.get_by_id("e1").plus_id == "plus-9"

    def test_plus_upload_errors(self):
        self.insert_mock_event("e1", data=_BOX_DATA)
        with self._snapshot():
            with (
                patch.object(self.plus, "upload_image", side_effect=RuntimeError()),
                AuthTestClient(self.app) as client,
            ):
                upload_failed = client.post("/events/e1/plus")
            assert upload_failed.json()["message"] == "Error uploading image"

            for error, message in (
                (ValueError("label"), "unsupported label"),
                (RuntimeError("down"), "Error uploading annotation"),
            ):
                Event.update(plus_id=None).where(Event.id == "e1").execute()
                with (
                    patch.object(self.plus, "upload_image", return_value="p"),
                    patch.object(self.plus, "add_annotation", side_effect=error),
                    AuthTestClient(self.app) as client,
                ):
                    response = client.post("/events/e1/plus", json={})
                assert response.status_code == 400
                assert message in response.json()["message"]

    def test_false_positive_guards(self):
        self.insert_mock_event("old", data={"type": "object"})
        self.insert_mock_event("done", data=_BOX_DATA)
        Event.update(false_positive=True).where(Event.id == "done").execute()

        with AuthTestClient(self.app) as client:
            old = client.put("/events/old/false_positive")
            done = client.put("/events/done/false_positive")

        assert "prior to 0.13" in old.json()["message"]
        assert "already submitted" in done.json()["message"]

    def test_false_positive_submits_after_upload(self):
        self.insert_mock_event("e1", data=_BOX_DATA, top_score=90)
        with (
            self._snapshot(),
            patch.object(self.plus, "upload_image", return_value="plus-2"),
            patch.object(self.plus, "add_annotation"),
            patch.object(self.plus, "add_false_positive") as add_fp,
        ):
            with AuthTestClient(self.app) as client:
                response = client.put("/events/e1/false_positive")

        assert response.status_code == 200
        assert response.json()["plus_id"] == "plus-2"
        args = add_fp.call_args.args
        assert args[0] == "plus-2"
        assert args[3] == 0.8  # data top_score stands in for the missing score
        assert Event.get_by_id("e1").false_positive is True

    def test_false_positive_upload_failure_is_returned(self):
        self.insert_mock_event("e1", data=_BOX_DATA)
        with patch(
            "frigate.api.event.load_event_snapshot_image", side_effect=OSError()
        ):
            with AuthTestClient(self.app) as client:
                response = client.put("/events/e1/false_positive")
        assert response.status_code == 400

    def test_false_positive_plus_errors(self):
        self.insert_mock_event("e1", data={**_BOX_DATA, "score": 0.7})
        Event.update(plus_id="plus-3").where(Event.id == "e1").execute()
        for error, message in (
            (ValueError("label"), "unsupported label"),
            (RuntimeError("down"), "Error uploading false positive"),
        ):
            with (
                patch.object(self.plus, "add_false_positive", side_effect=error),
                AuthTestClient(self.app) as client,
            ):
                response = client.put("/events/e1/false_positive")
            assert response.status_code == 400
            assert message in response.json()["message"]
        assert Event.get_by_id("e1").false_positive is False


class TestEventMetadataEndpoints(_EventHttpTestCase):
    def test_sub_label_set_and_clear(self):
        self.insert_mock_event("e1")
        with AuthTestClient(self.app) as client:
            set_label = client.post(
                "/events/e1/sub_label",
                json={"subLabel": "Bob", "subLabelScore": 0.9},
            )
            cleared = client.post("/events/e1/sub_label", json={"subLabel": ""})
            missing = client.post("/events/missing/sub_label", json={"subLabel": "x"})

        assert set_label.status_code == 200
        assert cleared.json()["message"] == "Event e1 sub label set to None"
        assert missing.status_code == 404
        assert self.published(EventMetadataTypeEnum.sub_label) == [
            ("e1", "Bob", 0.9),
            ("e1", None, None),
        ]

    def test_sub_label_for_tracked_object_without_event(self):
        state = MagicMock()
        state.tracked_objects = {"live-1": object()}
        self.app.detected_frames_processor = MagicMock()
        self.app.detected_frames_processor.get_camera_states.return_value = [state]

        with AuthTestClient(self.app) as client:
            response = client.post("/events/live-1/sub_label", json={"subLabel": "x"})
            plate = client.post(
                "/events/live-1/recognized_license_plate",
                json={"recognizedLicensePlate": "ABC123"},
            )

        assert response.status_code == 200
        assert plate.status_code == 200

    def test_license_plate_set_and_clear(self):
        self.insert_mock_event("e1")
        with AuthTestClient(self.app) as client:
            set_plate = client.post(
                "/events/e1/recognized_license_plate",
                json={
                    "recognizedLicensePlate": "ABC123",
                    "recognizedLicensePlateScore": 0.95,
                },
            )
            cleared = client.post(
                "/events/e1/recognized_license_plate",
                json={"recognizedLicensePlate": ""},
            )
            missing = client.post(
                "/events/missing/recognized_license_plate",
                json={"recognizedLicensePlate": "x"},
            )

        assert set_plate.json()["message"] == "Event e1 license plate set to ABC123"
        assert cleared.json()["message"] == "Event e1 license plate set to None"
        assert missing.status_code == 404
        assert self.published(EventMetadataTypeEnum.attribute) == [
            ("e1", "recognized_license_plate", "ABC123", 0.95),
            ("e1", "recognized_license_plate", None, None),
        ]

    def test_attributes(self):
        self.minimal_config["classification"] = {
            "custom": {
                "hats": {
                    "name": "hats",
                    "object_config": {
                        "objects": ["Mock"],
                        "classification_type": "attribute",
                    },
                },
                "bags": {
                    "object_config": {
                        "objects": ["Mock"],
                        "classification_type": "attribute",
                    },
                },
                "empty": {
                    "object_config": {
                        "objects": ["Mock"],
                        "classification_type": "attribute",
                    },
                },
                "cars": {
                    "object_config": {
                        "objects": ["car"],
                        "classification_type": "attribute",
                    },
                },
            }
        }
        self.app = super().create_app(event_metadata_publisher=self.publisher)
        for model, labels in (("hats", ["cap", "none"]), ("bags", ["backpack"])):
            for label in labels:
                os.makedirs(os.path.join(self.tmp_dir, model, "dataset", label))
        self.insert_mock_event("e1")

        with (
            patch("frigate.api.event.CLIPS_DIR", self.tmp_dir),
            AuthTestClient(self.app) as client,
        ):
            response = client.post(
                "/events/e1/attributes", json={"attributes": ["cap"]}
            )
            missing = client.post("/events/missing/attributes", json={})

        assert response.status_code == 200
        applied = {a["model"]: a["label"] for a in response.json()["applied"]}
        assert applied == {"hats": "cap", "bags": None}
        assert missing.status_code == 404

    def test_attributes_without_matching_models(self):
        self.insert_mock_event("e1")
        with AuthTestClient(self.app) as client:
            response = client.post("/events/e1/attributes", json={"attributes": ["x"]})
        assert response.status_code == 400

    def test_description_set_and_clear(self):
        self.insert_mock_event("e1")
        embeddings = MagicMock()
        self.app.embeddings = embeddings
        self.app.frigate_config.semantic_search.enabled = True

        with AuthTestClient(self.app) as client:
            set_response = client.post(
                "/events/e1/description", json={"description": "A dog"}
            )
            assert Event.get_by_id("e1").data["description"] == "A dog"
            cleared = client.post("/events/e1/description", json={"description": ""})
            missing = client.post(
                "/events/missing/description", json={"description": "x"}
            )

        assert set_response.json()["message"] == "Event e1 description set to A dog"
        assert cleared.json()["message"] == "Event e1 description is now blank"
        assert missing.status_code == 404
        embeddings.update_description.assert_called_once_with("e1", "A dog")
        embeddings.db.delete_embeddings_description.assert_called_once_with(
            event_ids=["e1"]
        )

    def test_regenerate_description(self):
        self.insert_mock_event("e1")
        with AuthTestClient(self.app) as client:
            refused = client.put("/events/e1/description/regenerate")
            forced = client.put(
                "/events/e1/description/regenerate",
                params={"source": "snapshot", "force": True},
            )
            missing = client.put("/events/missing/description/regenerate")

        assert refused.status_code == 400
        assert forced.status_code == 200
        assert "using snapshot" in forced.json()["message"]
        assert missing.status_code == 404
        assert self.published(EventMetadataTypeEnum.regenerate_description) == [
            ("e1", "snapshot", True)
        ]

    def test_generate_description_embedding(self):
        embeddings = MagicMock()
        embeddings.generate_description_embedding.return_value = [0.1]
        self.app.embeddings = embeddings
        self.app.frigate_config.semantic_search.enabled = True

        with AuthTestClient(self.app) as client:
            response = client.post(
                "/description/generate", json={"description": "a red car"}
            )

        assert response.status_code == 200
        assert response.json()["message"] == "Embedding for description is [0.1]"


class TestEventCreateEndDelete(_EventHttpTestCase):
    def test_create_event(self):
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/events/front_door/package/create",
                json={"score": 0.7, "sub_label": "ups", "duration": 10},
            )
            bad_camera = client.post("/events/missing/package/create", json={})

        assert response.status_code == 200
        event_id = response.json()["event_id"]
        created = self.published(EventMetadataTypeEnum.manual_event_create)
        assert len(created) == 1
        assert created[0][1:4] == ("front_door", "package", event_id)
        assert created[0][5:8] == (0.7, "ups", 10)
        assert bad_camera.status_code == 404

    def test_end_event(self):
        now = datetime.now().timestamp()
        self.insert_mock_event("e1", start_time=now)
        with AuthTestClient(self.app) as client:
            too_early = client.put("/events/e1/end", json={"end_time": now - 10})
            ended = client.put("/events/e1/end", json={"end_time": now + 5})
            default_end = client.put("/events/e1/end", json={})
            missing = client.put("/events/missing/end", json={})

        assert too_early.status_code == 400
        assert ended.status_code == 200
        assert default_end.status_code == 200
        assert missing.status_code == 404
        ends = self.published(EventMetadataTypeEnum.manual_event_end)
        assert ends[0] == ("e1", now + 5)
        assert ends[1][1] >= now

    def test_end_event_publish_failure(self):
        self.insert_mock_event("e1")
        self.publisher.publish.side_effect = RuntimeError("zmq down")
        with AuthTestClient(self.app) as client:
            response = client.put("/events/e1/end", json={})
        assert response.status_code == 404
        assert "must be set and valid" in response.json()["message"]

    def test_delete_single_event(self):
        self.insert_mock_event("e1")
        with (
            patch("frigate.api.event.delete_events_data") as delete_data,
            AuthTestClient(self.app) as client,
        ):
            deleted = client.delete("/events/e1")
            missing = client.delete("/events/missing")

        assert deleted.status_code == 200
        assert deleted.json()["message"] == "Event e1 deleted"
        assert missing.status_code == 404
        assert [e.id for e in delete_data.call_args.args[0]] == ["e1"]

    def test_delete_many_events(self):
        self.insert_mock_event("e1")
        self.insert_mock_event("e2")
        with AuthTestClient(self.app) as client:
            empty = client.request("DELETE", "/events/", json={"event_ids": []})
            response = client.request(
                "DELETE", "/events/", json={"event_ids": ["e1", "e2", "nope"]}
            )

        assert empty.status_code == 404
        body = response.json()
        assert sorted(body["deleted_events"]) == ["e1", "e2"]
        assert body["not_found_events"] == ["nope"]
        assert Event.select().count() == 0


class TestTriggers(_EventHttpTestCase):
    def setUp(self):
        super().setUp()
        self.embeddings = MagicMock()
        self.embeddings.generate_description_embedding.return_value = [0.5, 0.5]
        self.embeddings.generate_image_embedding.return_value = [0.25, 0.75]
        self.embeddings.db.execute_sql.return_value.fetchone.return_value = None
        self.app.embeddings = self.embeddings
        self.app.frigate_config.semantic_search.enabled = True
        patcher = patch("frigate.util.path.TRIGGER_DIR", self.tmp_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.thumb = b"webp-bytes"

    def _object_event(self, id: str, data: dict | None = None):
        self.insert_mock_event(id, data=data or {"type": "object"})
        Event.update(thumbnail=base64.b64encode(self.thumb).decode()).where(
            Event.id == id
        ).execute()

    def _trigger_path(self, data: str) -> str:
        return os.path.join(self.tmp_dir, "front_door", f"{data}.webp")

    def test_semantic_search_required(self):
        self.app.frigate_config.semantic_search.enabled = False
        body = {"type": "description", "data": "a dog"}
        with AuthTestClient(self.app) as client:
            create = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "t"},
                json=body,
            )
            update = client.put("/trigger/embedding/front_door/t", json=body)
        assert create.status_code == 400
        assert update.status_code == 400

    def test_create_description_trigger_and_status(self):
        with AuthTestClient(self.app) as client:
            created = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "dog"},
                json={"type": "description", "data": "a dog", "threshold": 0.6},
            )
            duplicate = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "dog"},
                json={"type": "description", "data": "a dog"},
            )
            no_triggers = client.get("/triggers/status/back")

        assert created.status_code == 200
        trigger = Trigger.get(Trigger.camera == "front_door", Trigger.name == "dog")
        assert trigger.threshold == 0.6
        assert np.frombuffer(trigger.embedding, dtype=np.float32).tolist() == [
            0.5,
            0.5,
        ]
        assert duplicate.status_code == 400
        assert no_triggers.status_code == 404

    def test_trigger_status_reports_last_trigger(self):
        Trigger.create(
            camera="front_door",
            name="dog",
            type="description",
            data="a dog",
            threshold=0.5,
            model="jinav1",
            embedding=b"",
            triggering_event_id="e9",
            last_triggered=datetime.fromtimestamp(1000),
        )
        with AuthTestClient(self.app) as client:
            response = client.get("/triggers/status/front_door")

        assert response.status_code == 200
        assert response.json()["triggers"]["dog"] == {
            "last_triggered": 1000.0,
            "triggering_event_id": "e9",
        }

    def test_create_thumbnail_trigger(self):
        self._object_event("e1")
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "cat"},
                json={"type": "thumbnail", "data": "e1"},
            )

        assert response.status_code == 200
        with open(self._trigger_path("e1"), "rb") as f:
            assert f.read() == self.thumb
        self.embeddings.generate_image_embedding.assert_called_once()

    def test_create_thumbnail_trigger_reuses_stored_embedding(self):
        self._object_event("e1")
        stored = np.array([1.0, 2.0], dtype=np.float32).tobytes()
        self.embeddings.db.execute_sql.return_value.fetchone.return_value = (stored,)
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "cat"},
                json={"type": "thumbnail", "data": "e1"},
            )

        assert response.status_code == 200
        self.embeddings.generate_image_embedding.assert_not_called()
        trigger = Trigger.get(Trigger.name == "cat")
        assert np.frombuffer(trigger.embedding, dtype=np.float32).tolist() == [
            1.0,
            2.0,
        ]

    def test_create_thumbnail_trigger_failures(self):
        self.insert_mock_event("no-thumb", data={"type": "object"})
        self.embeddings.generate_description_embedding.return_value = []
        with (
            patch("frigate.util.file.THUMB_DIR", self.tmp_dir),
            AuthTestClient(self.app) as client,
        ):
            missing = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "a"},
                json={"type": "thumbnail", "data": "missing"},
            )
            no_thumb = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "b"},
                json={"type": "thumbnail", "data": "no-thumb"},
            )
            empty_embedding = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "c"},
                json={"type": "description", "data": "x"},
            )

        assert "Failed to fetch event" in missing.json()["message"]
        assert "Failed to get thumbnail" in no_thumb.json()["message"]
        assert "Failed to generate embedding" in empty_embedding.json()["message"]
        assert Trigger.select().count() == 0

    def test_create_trigger_unexpected_error(self):
        self.embeddings.generate_description_embedding.side_effect = RuntimeError()
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "a"},
                json={"type": "description", "data": "x"},
            )
        assert response.status_code == 500

    def test_update_description_trigger_upserts(self):
        with AuthTestClient(self.app) as client:
            created = client.put(
                "/trigger/embedding/front_door/dog",
                json={"type": "description", "data": "a dog"},
            )
            self.embeddings.generate_description_embedding.return_value = [0.0, 1.0]
            updated = client.put(
                "/trigger/embedding/front_door/dog",
                json={"type": "description", "data": "a big dog", "threshold": 0.9},
            )

        assert created.status_code == 200
        assert updated.status_code == 200
        trigger = Trigger.get(Trigger.name == "dog")
        assert trigger.data == "a big dog"
        assert trigger.threshold == 0.9
        assert Trigger.select().count() == 1

    def test_update_thumbnail_trigger_from_event_and_from_disk(self):
        self._object_event("e1")
        os.makedirs(os.path.join(self.tmp_dir, "front_door"))
        with AuthTestClient(self.app) as client:
            from_event = client.put(
                "/trigger/embedding/front_door/cat",
                json={"type": "thumbnail", "data": "e1"},
            )
            Event.delete().where(Event.id == "e1").execute()
            from_disk = client.put(
                "/trigger/embedding/front_door/cat",
                json={"type": "thumbnail", "data": "e1"},
            )
            gone = client.put(
                "/trigger/embedding/front_door/cat",
                json={"type": "thumbnail", "data": "e2"},
            )

        assert from_event.status_code == 200
        assert from_disk.status_code == 200
        assert "Failed to fetch event" in gone.json()["message"]
        assert self.embeddings.generate_image_embedding.call_count == 2

    def test_update_thumbnail_trigger_rejects_non_objects(self):
        self._object_event("audio-1", data={"type": "audio"})
        with AuthTestClient(self.app) as client:
            response = client.put(
                "/trigger/embedding/front_door/cat",
                json={"type": "thumbnail", "data": "audio-1"},
            )
        assert "not a tracked object" in response.json()["message"]

    def test_update_trigger_replaces_old_thumbnail(self):
        self._object_event("e1")
        self._object_event("e2")
        # update writes the event thumbnail before it creates the camera folder
        os.makedirs(os.path.join(self.tmp_dir, "front_door"))
        with AuthTestClient(self.app) as client:
            client.put(
                "/trigger/embedding/front_door/cat",
                json={"type": "thumbnail", "data": "e1"},
            )
            assert os.path.exists(self._trigger_path("e1"))
            response = client.put(
                "/trigger/embedding/front_door/cat",
                json={"type": "thumbnail", "data": "e2"},
            )

        assert response.status_code == 200
        assert not os.path.exists(self._trigger_path("e1"))
        assert os.path.exists(self._trigger_path("e2"))

    def test_update_trigger_errors(self):
        with AuthTestClient(self.app) as client:
            self.embeddings.generate_description_embedding.return_value = None
            no_embedding = client.put(
                "/trigger/embedding/front_door/dog",
                json={"type": "description", "data": "x"},
            )
            self.embeddings.generate_description_embedding.side_effect = OSError()
            crashed = client.put(
                "/trigger/embedding/front_door/dog",
                json={"type": "description", "data": "x"},
            )
        assert no_embedding.status_code == 400
        assert crashed.status_code == 500

    def test_delete_trigger(self):
        self._object_event("e1")
        with AuthTestClient(self.app) as client:
            client.post(
                "/trigger/embedding",
                params={"camera_name": "front_door", "name": "cat"},
                json={"type": "thumbnail", "data": "e1"},
            )
            deleted = client.delete("/trigger/embedding/front_door/cat")
            missing = client.delete("/trigger/embedding/front_door/cat")

        assert deleted.status_code == 200
        assert not os.path.exists(self._trigger_path("e1"))
        assert Trigger.select().count() == 0
        assert missing.status_code == 500
        assert "not found" in missing.json()["message"]
