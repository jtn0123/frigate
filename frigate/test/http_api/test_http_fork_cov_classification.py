"""HTTP tests for the face, plate, reindex and classification endpoints (fork D70)."""

import os
import shutil
import tempfile
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from frigate.models import Event
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp
from frigate.util.classification import (
    read_training_metadata,
    write_training_metadata,
)

_VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}
_BAD_NAME = "..%3A"


def _camera() -> dict:
    return {
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
        },
        "detect": {"height": 1080, "width": 1920, "fps": 5},
    }


class _ClassificationHttpTestCase(BaseTestHttp):
    """Builds an app whose face and clips roots live in a temp directory."""

    enrichments_enabled = True

    def setUp(self):
        super().setUp([Event])
        self.minimal_config = {
            "mqtt": {"host": "mqtt"},
            "cameras": {"front_door": _camera()},
            "classification": {
                "custom": {
                    "dogs": {"object_config": {"objects": ["dog"]}},
                    "colors": {
                        "object_config": {
                            "objects": ["car"],
                            "classification_type": "attribute",
                        },
                    },
                    "hats": {
                        "object_config": {
                            "objects": ["person"],
                            "classification_type": "attribute",
                        },
                    },
                    "off": {
                        "enabled": False,
                        "object_config": {
                            "objects": ["car"],
                            "classification_type": "attribute",
                        },
                    },
                    "door": {
                        "state_config": {
                            "cameras": {"front_door": {"crop": [0, 0, 0.5, 0.5]}}
                        }
                    },
                }
            },
        }

        if self.enrichments_enabled:
            self.minimal_config["face_recognition"] = {"enabled": True}
            self.minimal_config["lpr"] = {"enabled": True}
            self.minimal_config["semantic_search"] = {"enabled": True}

        self.app = super().create_app()
        self.embeddings = MagicMock()
        self.app.embeddings = self.embeddings
        self.client = AuthTestClient(self.app)

        self.root = tempfile.mkdtemp()
        self.clips = os.path.join(self.root, "clips")
        self.faces = os.path.join(self.clips, "faces")
        self.model_cache = os.path.join(self.root, "model_cache")
        os.makedirs(self.faces)
        os.makedirs(self.model_cache)

        for target, value in (
            ("frigate.api.classification.CLIPS_DIR", self.clips),
            ("frigate.api.classification.FACE_DIR", self.faces),
            ("frigate.api.classification.MODEL_CACHE_DIR", self.model_cache),
            ("frigate.util.classification.CLIPS_DIR", self.clips),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _touch(self, *parts: str, content: bytes = b"img") -> str:
        path = os.path.join(*parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)

        with open(path, "wb") as f:
            f.write(content)

        return path

    def _png(self, *parts: str) -> str:
        path = os.path.join(*parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        cv2.imwrite(path, np.full((8, 8, 3), 127, dtype=np.uint8))
        return path


class TestFacesDisabled(_ClassificationHttpTestCase):
    enrichments_enabled = False

    def test_face_endpoints_refuse_when_face_recognition_is_off(self):
        calls = [
            ("post", "/faces/reprocess", {"json": {"training_file": "a.webp"}}),
            ("post", "/faces/train/bob/classify", {"json": {"event_id": "e"}}),
            ("post", "/faces/bob/create", {}),
            ("post", "/faces/bob/register", {"files": {"file": ("a.jpg", b"x")}}),
            ("post", "/faces/recognize", {"files": {"file": ("a.jpg", b"x")}}),
            ("post", "/faces/bob/reclassify", {"json": {"id": "a", "new_name": "b"}}),
            ("post", "/faces/bob/delete", {"json": {"ids": ["a"]}}),
            ("put", "/faces/bob/rename", {"json": {"new_name": "rob"}}),
        ]

        for method, url, kwargs in calls:
            with self.subTest(url=url):
                response = getattr(self.client, method)(url, **kwargs)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(),
                    {"message": "Face recognition is not enabled.", "success": False},
                )

        self.assertEqual(self.embeddings.mock_calls, [])
        self.assertEqual(os.listdir(self.faces), [])

    def test_plate_reprocess_and_reindex_refuse_when_disabled(self):
        plate = self.client.put("/lpr/reprocess", params={"event_id": "e1"})
        reindex = self.client.put("/reindex")

        self.assertEqual(plate.status_code, 400)
        self.assertEqual(
            plate.json()["message"], "License plate recognition is not enabled."
        )
        self.assertEqual(reindex.status_code, 400)
        self.assertIn("Semantic Search is not enabled", reindex.json()["message"])
        self.embeddings.reprocess_plate.assert_not_called()
        self.embeddings.reindex_embeddings.assert_not_called()

    def test_audio_transcription_refuses_when_camera_has_it_off(self):
        self.insert_mock_event("e1")

        response = self.client.put("/audio/transcribe", json={"event_id": "e1"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["message"],
            "Audio transcription is not enabled for front_door.",
        )
        self.embeddings.transcribe_audio.assert_not_called()


class TestFaceLibrary(_ClassificationHttpTestCase):
    def test_get_faces_lists_only_image_files_in_folders(self):
        self._touch(self.faces, "bob", "one.webp")
        self._touch(self.faces, "bob", "two.JPG")
        self._touch(self.faces, "bob", "notes.txt")
        self._touch(self.faces, "alice", "face.png")
        self._touch(self.faces, "stray.webp")

        response = self.client.get("/faces")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"bob", "alice"})
        self.assertEqual(sorted(body["bob"]), ["one.webp", "two.JPG"])
        self.assertEqual(body["alice"], ["face.png"])

    def test_get_faces_without_a_face_dir_is_empty(self):
        shutil.rmtree(self.faces)

        response = self.client.get("/faces")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {})

    def test_get_faces_requires_admin(self):
        response = self.client.get("/faces", headers=_VIEWER)

        self.assertEqual(response.status_code, 403)

    def test_create_face_makes_a_folder_with_underscores(self):
        response = self.client.post("/faces/jane doe/create")

        self.assertEqual(response.status_code, 200)
        # B28: the success flag was False
        self.assertEqual(
            response.json(),
            {"success": True, "message": "Successfully created face folder."},
        )
        self.assertTrue(os.path.isdir(os.path.join(self.faces, "jane_doe")))

    def test_create_face_rejects_an_unusable_name(self):
        response = self.client.post(f"/faces/{_BAD_NAME}/create")

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        self.assertEqual(os.listdir(self.faces), [])


class TestFaceReprocess(_ClassificationHttpTestCase):
    def test_missing_training_file_is_404(self):
        response = self.client.post(
            "/faces/reprocess", json={"training_file": "missing.webp"}
        )

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.json()["success"])
        self.embeddings.reprocess_face.assert_not_called()

    def test_empty_body_is_404(self):
        response = self.client.post("/faces/reprocess")

        self.assertEqual(response.status_code, 404)

    def test_reprocess_passes_the_resolved_file(self):
        path = self._touch(self.faces, "train", "attempt.webp")
        self.embeddings.reprocess_face.return_value = {"success": True, "face": "bob"}

        response = self.client.post(
            "/faces/reprocess", json={"training_file": "attempt.webp"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"success": True, "face": "bob"})
        self.embeddings.reprocess_face.assert_called_once_with(path)

    def test_unsuccessful_reprocess_is_400(self):
        self._touch(self.faces, "train", "attempt.webp")
        self.embeddings.reprocess_face.return_value = {"success": False}

        response = self.client.post(
            "/faces/reprocess", json={"training_file": "attempt.webp"}
        )

        self.assertEqual(response.status_code, 400)

    def test_non_dict_reprocess_result_is_500(self):
        self._touch(self.faces, "train", "attempt.webp")
        self.embeddings.reprocess_face.return_value = None

        response = self.client.post(
            "/faces/reprocess", json={"training_file": "attempt.webp"}
        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["message"], "Could not process request.")


class TestFaceTrain(_ClassificationHttpTestCase):
    def test_requires_a_file_or_event(self):
        response = self.client.post("/faces/train/bob/classify", json={})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["message"], "A training file or event_id must be passed."
        )

    def test_missing_training_file_is_404(self):
        response = self.client.post(
            "/faces/train/bob/classify", json={"training_file": "missing.webp"}
        )

        self.assertEqual(response.status_code, 404)
        self.assertIn("missing.webp", response.json()["message"])

    def test_unusable_name_is_400(self):
        self._touch(self.faces, "train", "attempt.webp")

        response = self.client.post(
            f"/faces/train/{_BAD_NAME}/classify",
            json={"training_file": "attempt.webp"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertTrue(
            os.path.exists(os.path.join(self.faces, "train", "attempt.webp"))
        )

    def test_training_file_moves_into_the_face_folder(self):
        self._touch(self.faces, "train", "attempt.webp")

        response = self.client.post(
            "/faces/train/bob/classify", json={"training_file": "attempt.webp"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertFalse(
            os.path.exists(os.path.join(self.faces, "train", "attempt.webp"))
        )
        saved = os.listdir(os.path.join(self.faces, "bob"))
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0].startswith("bob-"))
        self.assertTrue(saved[0].endswith(".webp"))
        self.embeddings.clear_face_classifier.assert_called_once_with()

    def test_unknown_event_is_404(self):
        response = self.client.post(
            "/faces/train/bob/classify", json={"event_id": "nope"}
        )

        self.assertEqual(response.status_code, 404)
        self.assertIn("nope", response.json()["message"])
        self.embeddings.clear_face_classifier.assert_not_called()

    def test_event_face_is_cropped_from_the_snapshot(self):
        self.insert_mock_event(
            "e1", data={"attributes": [{"box": [0.1, 0.1, 0.1, 0.1]}]}
        )
        snapshot = np.zeros((1080, 1920, 3), dtype=np.uint8)

        with patch(
            "frigate.api.classification.get_event_snapshot", return_value=snapshot
        ) as get_snapshot:
            response = self.client.post(
                "/faces/train/bob/classify", json={"event_id": "e1"}
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(get_snapshot.call_args.args[0].id, "e1")
        saved = os.listdir(os.path.join(self.faces, "bob"))
        self.assertEqual(len(saved), 1)
        face = cv2.imread(os.path.join(self.faces, "bob", saved[0]))
        # x: 192 + 2 to 194 + 192 - 4, y: 108 + 2 to 110 + 108 - 4
        self.assertEqual(face.shape[:2], (104, 188))
        self.embeddings.clear_face_classifier.assert_called_once_with()

    def _train_from_event(self, box, **imwrite):
        self.insert_mock_event("e1", data={"attributes": [{"box": box}]})
        snapshot = np.zeros((1080, 1920, 3), dtype=np.uint8)
        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    "frigate.api.classification.get_event_snapshot",
                    return_value=snapshot,
                )
            )
            if imwrite:
                stack.enter_context(
                    patch("frigate.api.classification.cv2.imwrite", **imwrite)
                )

            return self.client.post(
                "/faces/train/bob/classify", json={"event_id": "e1"}
            )

    def assert_face_not_saved(self, response):
        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(),
            {"success": False, "message": "Invalid face box or no face exists"},
        )
        self.assertEqual(os.listdir(os.path.join(self.faces, "bob")), [])
        self.embeddings.clear_face_classifier.assert_not_called()

    def test_face_write_failure_is_404(self):
        # B28: success was set before the write, so a failed write was
        # reported as saved and still cleared the classifier
        response = self._train_from_event(
            [0.1, 0.1, 0.1, 0.1], side_effect=OSError("disk full")
        )

        self.assert_face_not_saved(response)

    def test_face_write_returning_false_is_404(self):
        response = self._train_from_event([0.1, 0.1, 0.1, 0.1], return_value=False)

        self.assert_face_not_saved(response)

    def test_empty_face_box_is_404(self):
        # B28: an empty crop wrote nothing but returned 200 "Successfully saved"
        response = self._train_from_event([0.1, 0.1, 0.0, 0.0])

        self.assert_face_not_saved(response)


class TestFaceRegisterAndRecognize(_ClassificationHttpTestCase):
    def test_register_sends_the_upload_to_embeddings(self):
        self.embeddings.register_face.return_value = {"success": True}

        response = self.client.post(
            "/faces/bob/register", files={"file": ("face.jpg", b"jpeg-bytes")}
        )

        self.assertEqual(response.status_code, 200)
        self.embeddings.register_face.assert_called_once_with("bob", b"jpeg-bytes")

    def test_register_failure_is_400(self):
        self.embeddings.register_face.return_value = {
            "success": False,
            "message": "no face",
        }

        response = self.client.post(
            "/faces/bob/register", files={"file": ("face.jpg", b"x")}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "no face")

    def test_register_without_embeddings_is_500(self):
        self.app.embeddings = None

        response = self.client.post(
            "/faces/bob/register", files={"file": ("face.jpg", b"x")}
        )

        self.assertEqual(response.status_code, 500)
        self.assertIn("Try restarting Frigate", response.json()["message"])

    def test_register_rejects_an_unusable_name(self):
        response = self.client.post(
            f"/faces/{_BAD_NAME}/register", files={"file": ("face.jpg", b"x")}
        )

        self.assertEqual(response.status_code, 400)
        self.embeddings.register_face.assert_not_called()

    def test_recognize_returns_the_embeddings_result(self):
        self.embeddings.recognize_face.return_value = {
            "success": True,
            "face_name": "bob",
            "score": 0.9,
        }

        response = self.client.post(
            "/faces/recognize", files={"file": ("face.jpg", b"jpeg")}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["face_name"], "bob")
        self.embeddings.recognize_face.assert_called_once_with(b"jpeg")

    def test_recognize_failure_and_bad_result(self):
        self.embeddings.recognize_face.return_value = {"success": False}
        failed = self.client.post("/faces/recognize", files={"file": ("f", b"x")})

        self.embeddings.recognize_face.return_value = "oops"
        broken = self.client.post("/faces/recognize", files={"file": ("f", b"x")})

        self.assertEqual(failed.status_code, 400)
        self.assertEqual(broken.status_code, 500)


class TestFaceReclassifyDeleteRename(_ClassificationHttpTestCase):
    def test_reclassify_requires_id_and_new_name(self):
        response = self.client.post("/faces/bob/reclassify", json={"id": "a.webp"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["message"], "Both 'id' and 'new_name' are required."
        )

    def test_reclassify_to_the_same_name_is_400(self):
        response = self.client.post(
            "/faces/bob/reclassify", json={"id": "a.webp", "new_name": "bob"}
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("must differ", response.json()["message"])

    def test_reclassify_from_an_unusable_name_is_400(self):
        response = self.client.post(
            f"/faces/{_BAD_NAME}/reclassify",
            json={"id": "a.webp", "new_name": "rob"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(os.path.exists(os.path.join(self.faces, "rob")))

    def test_reclassify_missing_image_is_404(self):
        response = self.client.post(
            "/faces/bob/reclassify", json={"id": "a.webp", "new_name": "rob"}
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["message"], "Image not found: a.webp")

    def test_reclassify_moves_the_image_and_removes_an_empty_folder(self):
        self._touch(self.faces, "bob", "a.webp")

        response = self.client.post(
            "/faces/bob/reclassify", json={"id": "a.webp", "new_name": "rob"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(os.path.join(self.faces, "bob")))
        moved = os.listdir(os.path.join(self.faces, "rob"))
        self.assertEqual(len(moved), 1)
        self.assertTrue(moved[0].startswith("rob-"))
        self.embeddings.clear_face_classifier.assert_called_once_with()

    def test_reclassify_keeps_a_source_folder_that_still_has_images(self):
        self._touch(self.faces, "bob", "a.webp")
        self._touch(self.faces, "bob", "b.webp")

        response = self.client.post(
            "/faces/bob/reclassify", json={"id": "a.webp", "new_name": "rob"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(os.listdir(os.path.join(self.faces, "bob")), ["b.webp"])

    def test_delete_passes_sanitized_ids(self):
        response = self.client.post(
            "/faces/bob/delete", json={"ids": ["a.webp", "..", "b:c.webp"]}
        )

        self.assertEqual(response.status_code, 200)
        self.embeddings.delete_face_ids.assert_called_once_with(
            "bob", ["a.webp", "bc.webp"]
        )

    def test_delete_rejects_an_unusable_name(self):
        response = self.client.post(f"/faces/{_BAD_NAME}/delete", json={"ids": ["a"]})

        self.assertEqual(response.status_code, 400)
        self.embeddings.delete_face_ids.assert_not_called()

    def test_rename_calls_embeddings(self):
        response = self.client.put("/faces/bob/rename", json={"new_name": "rob"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["message"], "Successfully renamed face to rob."
        )
        self.embeddings.rename_face.assert_called_once_with("bob", "rob")

    def test_rename_value_error_is_400(self):
        self.embeddings.rename_face.side_effect = ValueError("exists")

        with self.assertLogs("frigate.api.classification", level="ERROR"):
            response = self.client.put("/faces/bob/rename", json={"new_name": "rob"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["message"], "Error renaming face. Check Frigate logs."
        )


class TestPlateReindexAudio(_ClassificationHttpTestCase):
    def test_plate_reprocess_unknown_event_is_404(self):
        response = self.client.put("/lpr/reprocess", params={"event_id": "nope"})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["message"], "Event nope not found")

    def test_plate_reprocess_passes_the_event(self):
        self.insert_mock_event("e1")
        self.embeddings.reprocess_plate.return_value = {"success": True}

        response = self.client.put("/lpr/reprocess", params={"event_id": "e1"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"success": True})
        event = self.embeddings.reprocess_plate.call_args.args[0]
        self.assertEqual(event["id"], "e1")
        self.assertEqual(event["camera"], "front_door")

    def test_reindex_maps_each_result_to_a_status(self):
        for result, status in (
            ("started", 202),
            ("in_progress", 409),
            ("error", 500),
        ):
            with self.subTest(result=result):
                self.embeddings.reindex_embeddings.return_value = result
                response = self.client.put("/reindex")
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["success"], result == "started")

    def test_transcribe_unknown_event_is_404(self):
        response = self.client.put("/audio/transcribe", json={"event_id": "nope"})

        self.assertEqual(response.status_code, 404)

    def test_transcribe_maps_each_result_to_a_status(self):
        self.insert_mock_event("e1")
        camera = self.app.frigate_config.cameras["front_door"]
        camera.audio_transcription.enabled = True

        for result, status in (
            ("started", 202),
            ("in_progress", 409),
            (None, 500),
        ):
            with self.subTest(result=result):
                self.embeddings.transcribe_audio.return_value = result
                response = self.client.put("/audio/transcribe", json={"event_id": "e1"})
                self.assertEqual(response.status_code, status)

        self.assertEqual(self.embeddings.transcribe_audio.call_args.args[0]["id"], "e1")


class TestClassificationDataset(_ClassificationHttpTestCase):
    def test_dataset_rejects_an_unusable_name(self):
        response = self.client.get(f"/classification/{_BAD_NAME}/dataset")

        self.assertEqual(response.status_code, 400)

    def test_missing_dataset_is_empty(self):
        response = self.client.get("/classification/dogs/dataset")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"categories": {}, "training_metadata": None})

    def test_untrained_dataset_reports_every_image_as_new(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        self._touch(self.clips, "dogs", "dataset", "lab", "b.jpeg")
        self._touch(self.clips, "dogs", "dataset", "lab", "c.txt")
        self._touch(self.clips, "dogs", "dataset", "none", "d.webp")
        self._touch(self.clips, "dogs", "dataset", "loose.png")

        response = self.client.get("/classification/dogs/dataset")

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(sorted(body["categories"]["lab"]), ["a.png", "b.jpeg"])
        self.assertEqual(body["categories"]["none"], ["d.webp"])
        metadata = body["training_metadata"]
        self.assertFalse(metadata["has_trained"])
        self.assertIsNone(metadata["last_training_date"])
        self.assertEqual(metadata["current_image_count"], 3)
        self.assertEqual(metadata["new_images_count"], 3)
        self.assertTrue(metadata["dataset_changed"])

    def test_trained_dataset_counts_new_images(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        self._touch(self.clips, "dogs", "dataset", "lab", "b.png")
        write_training_metadata("dogs", 1)

        metadata = self.client.get("/classification/dogs/dataset").json()[
            "training_metadata"
        ]

        self.assertTrue(metadata["has_trained"])
        self.assertIsNotNone(metadata["last_training_date"])
        self.assertEqual(metadata["last_training_image_count"], 1)
        self.assertEqual(metadata["new_images_count"], 1)
        self.assertTrue(metadata["dataset_changed"])

    def test_trained_dataset_after_deletions_has_no_negative_count(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        write_training_metadata("dogs", 5)

        metadata = self.client.get("/classification/dogs/dataset").json()[
            "training_metadata"
        ]

        self.assertEqual(metadata["new_images_count"], 0)
        self.assertTrue(metadata["dataset_changed"])

    def test_train_images_listing(self):
        self.assertEqual(self.client.get("/classification/dogs/train").json(), [])

        self._touch(self.clips, "dogs", "train", "a.webp")
        self._touch(self.clips, "dogs", "train", "b.txt")
        response = self.client.get("/classification/dogs/train")

        self.assertEqual(response.json(), ["a.webp"])
        self.assertEqual(
            self.client.get(f"/classification/{_BAD_NAME}/train").status_code, 400
        )


class TestClassificationAttributes(_ClassificationHttpTestCase):
    def setUp(self):
        super().setUp()
        for model, category in (
            ("colors", "red"),
            ("colors", "blue"),
            ("colors", "none"),
            ("hats", "cap"),
            ("hats", "red"),
            ("off", "green"),
            ("dogs", "lab"),
        ):
            os.makedirs(os.path.join(self.clips, model, "dataset", category))
        self._touch(self.clips, "colors", "dataset", "stray.png")

    def test_flat_list_is_unique_and_sorted(self):
        response = self.client.get("/classification/attributes")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), ["blue", "cap", "red"])

    def test_grouped_by_model_name(self):
        response = self.client.get(
            "/classification/attributes", params={"group_by_model": True}
        )

        self.assertEqual(
            response.json(), {"colors": ["blue", "red"], "hats": ["cap", "red"]}
        )

    def test_filtered_by_object_type(self):
        response = self.client.get(
            "/classification/attributes", params={"object_type": "car"}
        )

        self.assertEqual(response.json(), ["blue", "red"])

    def test_models_without_a_dataset_are_skipped(self):
        shutil.rmtree(os.path.join(self.clips, "hats"))

        response = self.client.get(
            "/classification/attributes", params={"group_by_model": True}
        )

        self.assertEqual(list(response.json()), ["colors"])


class TestClassificationTraining(_ClassificationHttpTestCase):
    def test_train_unknown_model_is_404(self):
        response = self.client.post("/classification/cats/train")

        self.assertEqual(response.status_code, 404)
        self.embeddings.start_classification_training.assert_not_called()

    def test_train_starts_training(self):
        response = self.client.post("/classification/dogs/train")

        self.assertEqual(response.status_code, 200)
        self.embeddings.start_classification_training.assert_called_once_with("dogs")

    def test_unknown_model_is_404_for_every_dataset_write(self):
        calls = [
            ("post", "/classification/cats/dataset/a/delete", {"json": {"ids": []}}),
            ("post", "/classification/cats/dataset/a/reclassify", {"json": {}}),
            ("put", "/classification/cats/dataset/a/rename", {"json": {}}),
            ("post", "/classification/cats/dataset/categorize", {"json": {}}),
            ("post", "/classification/cats/dataset/a/create", {}),
            ("post", "/classification/cats/train/delete", {"json": {"ids": []}}),
        ]

        for method, url, kwargs in calls:
            with self.subTest(url=url):
                response = getattr(self.client, method)(url, **kwargs)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(
                    response.json()["message"],
                    "cats is not a known classification model.",
                )

        self.assertEqual(os.listdir(self.clips), ["faces"])


class TestClassificationDatasetDelete(_ClassificationHttpTestCase):
    def test_delete_removes_files_and_empty_category(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        write_training_metadata("dogs", 4)

        response = self.client.post(
            "/classification/dogs/dataset/lab/delete",
            json={"ids": ["a.png", "missing.png", ".."]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            os.path.exists(os.path.join(self.clips, "dogs", "dataset", "lab"))
        )
        self.assertEqual(read_training_metadata("dogs")["last_training_image_count"], 3)

    def test_delete_keeps_the_none_category_and_untrained_metadata(self):
        self._touch(self.clips, "dogs", "dataset", "none", "a.png")

        response = self.client.post(
            "/classification/dogs/dataset/none/delete", json={"ids": ["a.png"]}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            os.listdir(os.path.join(self.clips, "dogs", "dataset", "none")), []
        )
        self.assertIsNone(read_training_metadata("dogs"))

    def test_delete_with_nothing_removed_leaves_metadata(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        write_training_metadata("dogs", 4)

        response = self.client.post(
            "/classification/dogs/dataset/lab/delete", json={"ids": ["other.png"]}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(read_training_metadata("dogs")["last_training_image_count"], 4)
        self.assertTrue(
            os.path.exists(os.path.join(self.clips, "dogs", "dataset", "lab", "a.png"))
        )

    def test_delete_rejects_an_unusable_category(self):
        response = self.client.post(
            f"/classification/dogs/dataset/{_BAD_NAME}/delete", json={"ids": []}
        )

        self.assertEqual(response.status_code, 400)


class TestClassificationReclassify(_ClassificationHttpTestCase):
    def test_requires_id_and_new_category(self):
        response = self.client.post(
            "/classification/dogs/dataset/lab/reclassify", json={"id": "a.png"}
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("new_category", response.json()["message"])

    def test_same_category_is_400(self):
        response = self.client.post(
            "/classification/dogs/dataset/lab/reclassify",
            json={"id": "a.png", "new_category": "lab"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("must differ", response.json()["message"])

    def test_unusable_category_is_400(self):
        response = self.client.post(
            f"/classification/dogs/dataset/{_BAD_NAME}/reclassify",
            json={"id": "a.png", "new_category": "pug"},
        )

        self.assertEqual(response.status_code, 400)

    def test_missing_image_is_404(self):
        response = self.client.post(
            "/classification/dogs/dataset/lab/reclassify",
            json={"id": "a.png", "new_category": "pug"},
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["message"], "Image not found: a.png")

    def test_image_is_resaved_as_png_in_the_new_category(self):
        self._png(self.clips, "dogs", "dataset", "lab", "a.png")
        write_training_metadata("dogs", 9)

        response = self.client.post(
            "/classification/dogs/dataset/lab/reclassify",
            json={"id": "a.png", "new_category": "pug"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            os.path.exists(os.path.join(self.clips, "dogs", "dataset", "lab"))
        )
        moved = os.listdir(os.path.join(self.clips, "dogs", "dataset", "pug"))
        self.assertEqual(len(moved), 1)
        self.assertTrue(moved[0].startswith("pug-"))
        self.assertTrue(moved[0].endswith(".png"))
        self.assertEqual(read_training_metadata("dogs")["last_training_image_count"], 0)

    def test_none_source_folder_is_kept_when_emptied(self):
        self._png(self.clips, "dogs", "dataset", "none", "a.png")

        response = self.client.post(
            "/classification/dogs/dataset/none/reclassify",
            json={"id": "a.png", "new_category": "pug"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            os.path.isdir(os.path.join(self.clips, "dogs", "dataset", "none"))
        )


class TestClassificationRename(_ClassificationHttpTestCase):
    def test_new_category_is_required(self):
        response = self.client.put("/classification/dogs/dataset/lab/rename", json={})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "New category name is required.")

    def test_unusable_old_category_is_400(self):
        response = self.client.put(
            f"/classification/dogs/dataset/{_BAD_NAME}/rename",
            json={"new_category": "pug"},
        )

        self.assertEqual(response.status_code, 400)

    def test_missing_category_is_404(self):
        response = self.client.put(
            "/classification/dogs/dataset/lab/rename", json={"new_category": "pug"}
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["message"], "Category lab does not exist.")

    def test_existing_target_is_400(self):
        os.makedirs(os.path.join(self.clips, "dogs", "dataset", "lab"))
        os.makedirs(os.path.join(self.clips, "dogs", "dataset", "pug"))

        response = self.client.put(
            "/classification/dogs/dataset/lab/rename", json={"new_category": "pug"}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "Category pug already exists.")

    def test_rename_moves_the_folder_and_resets_metadata(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        write_training_metadata("dogs", 7)

        response = self.client.put(
            "/classification/dogs/dataset/lab/rename", json={"new_category": "pug"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            os.listdir(os.path.join(self.clips, "dogs", "dataset", "pug")), ["a.png"]
        )
        self.assertFalse(
            os.path.exists(os.path.join(self.clips, "dogs", "dataset", "lab"))
        )
        self.assertEqual(read_training_metadata("dogs")["last_training_image_count"], 0)

    def test_rename_os_error_is_500(self):
        os.makedirs(os.path.join(self.clips, "dogs", "dataset", "lab"))

        with (
            patch(
                "frigate.api.classification.os.rename",
                side_effect=OSError("busy"),
            ),
            self.assertLogs("frigate.api.classification", level="ERROR"),
        ):
            response = self.client.put(
                "/classification/dogs/dataset/lab/rename",
                json={"new_category": "pug"},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["message"], "Failed to rename category")


class TestClassificationCategorizeAndCreate(_ClassificationHttpTestCase):
    def test_categorize_rejects_an_unusable_category(self):
        response = self.client.post(
            "/classification/dogs/dataset/categorize",
            json={"category": "..", "training_file": "a.webp"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "Invalid name: ..")

    def test_categorize_without_a_training_file_is_400(self):
        # B28: a missing training_file ran cv2.imread(None) and os.unlink(None)
        response = self.client.post(
            "/classification/dogs/dataset/categorize", json={"category": "lab"}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(),
            {"success": False, "message": "A training file must be passed."},
        )
        self.assertFalse(os.path.exists(os.path.join(self.clips, "dogs", "dataset")))

    def test_categorize_missing_training_file_is_404(self):
        response = self.client.post(
            "/classification/dogs/dataset/categorize",
            json={"category": "lab", "training_file": "a.webp"},
        )

        self.assertEqual(response.status_code, 404)
        self.assertIn("a.webp", response.json()["message"])

    def test_categorize_moves_the_training_image_into_the_dataset(self):
        self._png(self.clips, "dogs", "train", "a.png")

        response = self.client.post(
            "/classification/dogs/dataset/categorize",
            json={"category": "lab", "training_file": "a.png"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(os.listdir(os.path.join(self.clips, "dogs", "train")), [])
        saved = os.listdir(os.path.join(self.clips, "dogs", "dataset", "lab"))
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0].startswith("lab-"))
        image = cv2.imread(os.path.join(self.clips, "dogs", "dataset", "lab", saved[0]))
        self.assertEqual(image.shape, (8, 8, 3))

    def test_create_category_folder(self):
        response = self.client.post("/classification/dogs/dataset/lab/create")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            os.path.isdir(os.path.join(self.clips, "dogs", "dataset", "lab"))
        )
        self.assertEqual(
            response.json()["message"], "Successfully created category folder: lab"
        )

    def test_create_category_rejects_an_unusable_category(self):
        response = self.client.post(f"/classification/dogs/dataset/{_BAD_NAME}/create")

        self.assertEqual(response.status_code, 400)
        self.assertFalse(os.path.exists(os.path.join(self.clips, "dogs")))

    def test_delete_train_images(self):
        self._touch(self.clips, "dogs", "train", "a.webp")
        self._touch(self.clips, "dogs", "train", "b.webp")

        response = self.client.post(
            "/classification/dogs/train/delete", json={"ids": ["a.webp", "zz", ".."]}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            os.listdir(os.path.join(self.clips, "dogs", "train")), ["b.webp"]
        )


class TestGenerateExamples(_ClassificationHttpTestCase):
    def test_state_examples_keep_only_configured_cameras(self):
        with patch(
            "frigate.api.classification.collect_state_classification_examples"
        ) as collect:
            response = self.client.post(
                "/classification/generate_examples/state",
                json={
                    "model_name": "door",
                    "cameras": {
                        "front_door": [0.1, 0.2, 0.3, 0.4],
                        "garage": [0, 0, 1, 1],
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        collect.assert_called_once_with("door", {"front_door": (0.1, 0.2, 0.3, 0.4)})

    def test_state_examples_reject_an_unusable_model_name(self):
        with patch(
            "frigate.api.classification.collect_state_classification_examples"
        ) as collect:
            response = self.client.post(
                "/classification/generate_examples/state",
                json={"model_name": "..", "cameras": {}},
            )

        self.assertEqual(response.status_code, 400)
        collect.assert_not_called()

    def test_object_examples(self):
        with patch(
            "frigate.api.classification.collect_object_classification_examples"
        ) as collect:
            response = self.client.post(
                "/classification/generate_examples/object",
                json={"model_name": "dogs", "label": "dog"},
            )
            rejected = self.client.post(
                "/classification/generate_examples/object",
                json={"model_name": "..", "label": "dog"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"], "Example generation completed")
        self.assertEqual(rejected.status_code, 400)
        collect.assert_called_once_with("dogs", "dog")


class TestDeleteClassificationModel(_ClassificationHttpTestCase):
    def test_delete_model_without_any_data_still_succeeds(self):
        response = self.client.delete("/classification/ghost")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["message"],
            "Successfully deleted classification model ghost.",
        )

    def test_delete_model_removes_both_directories(self):
        self._touch(self.clips, "dogs", "dataset", "lab", "a.png")
        self._touch(self.model_cache, "dogs", "model.tflite")

        response = self.client.delete("/classification/dogs")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(os.path.join(self.clips, "dogs")))
        self.assertFalse(os.path.exists(os.path.join(self.model_cache, "dogs")))

    def test_delete_model_survives_rmtree_errors(self):
        os.makedirs(os.path.join(self.clips, "dogs"))
        os.makedirs(os.path.join(self.model_cache, "dogs"))

        with patch(
            "frigate.api.classification.shutil.rmtree",
            side_effect=OSError("busy"),
        ) as rmtree:
            response = self.client.delete("/classification/dogs")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(rmtree.call_count, 2)
        self.assertTrue(os.path.isdir(os.path.join(self.clips, "dogs")))
