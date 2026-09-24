"""Tests for the categorized object names aggregation used by GenAI chat."""

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from frigate.config.classification import ObjectClassificationType
from frigate.util import object_names
from frigate.util.object_names import get_categorized_object_names


def _camera(track: list[str], lpr: bool = False, face: bool = False):
    return SimpleNamespace(
        objects=SimpleNamespace(track=track),
        lpr=SimpleNamespace(enabled=lpr),
        face_recognition=SimpleNamespace(enabled=face),
    )


def _config(cameras, known_plates=None, custom=None):
    attributes_map = {
        "person": ["face", "amazon"],
        "car": ["license_plate", "ups"],
    }
    return SimpleNamespace(
        cameras=cameras,
        model=SimpleNamespace(
            attributes_map=attributes_map,
            all_attribute_logos=["amazon", "ups"],
        ),
        lpr=SimpleNamespace(known_plates=known_plates or {}),
        classification=SimpleNamespace(custom=custom or {}),
    )


class TestCategorizedObjectNames(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.face_dir = os.path.join(self.tmp.name, "faces")
        self.clips_dir = os.path.join(self.tmp.name, "clips")
        self.cache_dir = os.path.join(self.tmp.name, "cache")

        for attr, value in (
            ("FACE_DIR", self.face_dir),
            ("CLIPS_DIR", self.clips_dir),
            ("MODEL_CACHE_DIR", self.cache_dir),
        ):
            patcher = patch.object(object_names, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_logos_limited_to_tracked_objects_on_allowed_cameras(self):
        config = _config(
            {"front": _camera(["person"]), "garage": _camera(["car"])},
        )

        self.assertEqual(
            get_categorized_object_names(config, ["front"]),
            {"person": ["amazon"]},
        )
        self.assertEqual(
            get_categorized_object_names(config, ["front", "garage", "missing"]),
            {"car": ["ups"], "person": ["amazon"]},
        )

    def test_known_plates_require_lpr_on_an_allowed_camera(self):
        cameras = {
            "front": _camera(["car"]),
            "lpr": _camera(["license_plate"], lpr=True),
        }
        config = _config(cameras, known_plates={"Mom": ["ABC123"]})

        self.assertEqual(
            get_categorized_object_names(config, ["front"]), {"car": ["ups"]}
        )
        self.assertEqual(
            get_categorized_object_names(config, ["front", "lpr"]),
            {"car": ["Mom", "ups"], "license_plate": ["Mom"]},
        )

    def test_face_names_skip_train_dir_and_files(self):
        os.makedirs(os.path.join(self.face_dir, "alice"))
        os.makedirs(os.path.join(self.face_dir, "train"))
        with open(os.path.join(self.face_dir, "note.txt"), "w") as f:
            f.write("x")

        config = _config({"front": _camera(["person"], face=True)})

        self.assertEqual(
            get_categorized_object_names(config, ["front"], "person"),
            {"person": ["alice", "amazon"]},
        )
        self.assertEqual(get_categorized_object_names(config, ["front"], "car"), {})

    def test_classification_categories_from_labelmap_and_dataset(self):
        os.makedirs(os.path.join(self.cache_dir, "birds"))
        with open(os.path.join(self.cache_dir, "birds", "labelmap.txt"), "w") as f:
            f.write("blue jay\nnone\n")
        os.makedirs(os.path.join(self.clips_dir, "birds", "dataset", "cardinal"))

        def model(enabled=True, kind=ObjectClassificationType.sub_label):
            return SimpleNamespace(
                enabled=enabled,
                object_config=SimpleNamespace(
                    classification_type=kind, objects=["bird"]
                ),
            )

        config = _config(
            {"yard": _camera(["bird"])},
            custom={
                "birds": model(),
                "disabled": model(enabled=False),
                "attrs": model(kind=ObjectClassificationType.attribute),
                "state": SimpleNamespace(enabled=True, object_config=None),
                "empty": model(),
            },
        )

        self.assertEqual(
            get_categorized_object_names(config, ["yard"]),
            {"bird": ["blue jay", "cardinal"]},
        )

    def test_missing_face_dir_yields_only_logos(self):
        config = _config({"front": _camera(["person"], face=True)})

        self.assertFalse(os.path.exists(self.face_dir))
        self.assertEqual(
            get_categorized_object_names(config, ["front"]),
            {"person": ["amazon"]},
        )

    def test_unreadable_face_dir_is_skipped(self):
        os.makedirs(os.path.join(self.face_dir, "alice"))
        config = _config({"front": _camera(["person"], face=True)})

        with patch.object(
            object_names.os, "listdir", side_effect=PermissionError("denied")
        ):
            names = get_categorized_object_names(config, ["front"])

        self.assertEqual(names, {"person": ["amazon"]})

    def test_unreadable_classification_files_are_skipped(self):
        os.makedirs(os.path.join(self.cache_dir, "birds"))
        with open(os.path.join(self.cache_dir, "birds", "labelmap.txt"), "w") as f:
            f.write("blue jay\n")
        os.makedirs(os.path.join(self.clips_dir, "birds", "dataset", "cardinal"))

        config = _config(
            {"yard": _camera(["bird"])},
            custom={
                "birds": SimpleNamespace(
                    enabled=True,
                    object_config=SimpleNamespace(
                        classification_type=ObjectClassificationType.sub_label,
                        objects=["bird"],
                    ),
                )
            },
        )

        with (
            patch.object(
                object_names, "load_labels", side_effect=OSError("unreadable")
            ),
            patch.object(object_names.os, "listdir", side_effect=OSError("gone")),
        ):
            names = get_categorized_object_names(config, ["yard"])

        # no categories could be read, so the object type is omitted entirely
        self.assertEqual(names, {})


if __name__ == "__main__":
    unittest.main()
