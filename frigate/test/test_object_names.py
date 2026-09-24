"""Object-name discovery must respect camera visibility and filesystem errors."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frigate.util import object_names as module


class TestObjectNames(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, path in (
            ("FACE_DIR", self.root / "faces"),
            ("CLIPS_DIR", self.root / "clips"),
            ("MODEL_CACHE_DIR", self.root / "models"),
        ):
            patcher = patch.object(module, name, str(path))
            patcher.start()
            self.addCleanup(patcher.stop)
        camera = SimpleNamespace(
            objects=SimpleNamespace(track=["person", "car", "license_plate"]),
            lpr=SimpleNamespace(enabled=True),
            face_recognition=SimpleNamespace(enabled=True),
        )
        self.config = SimpleNamespace(
            cameras={"front": camera},
            model=SimpleNamespace(
                all_attribute_logos=["ups"],
                attributes_map={
                    "person": ["face"],
                    "car": ["license_plate", "ups"],
                    "dog": ["ups"],
                },
            ),
            lpr=SimpleNamespace(known_plates={"Family": ["ABC"]}),
            classification=SimpleNamespace(custom={}),
        )

    def test_names_aggregate_sort_and_filter_without_structural_attributes(self):
        faces = Path(module.FACE_DIR)
        faces.mkdir()
        for name in ("train", "Zoe", "Amy"):
            (faces / name).mkdir()
        (faces / "not-a-person.txt").write_text("file")
        self.assertEqual(
            module.get_categorized_object_names(self.config, ["front", "removed"]),
            {
                "car": ["Family", "ups"],
                "license_plate": ["Family"],
                "person": ["Amy", "Zoe"],
            },
        )
        self.assertEqual(
            module.get_categorized_object_names(self.config, ["front"], "car"),
            {"car": ["Family", "ups"]},
        )
        self.assertEqual(module.get_categorized_object_names(self.config, []), {})
        camera = self.config.cameras["front"]
        camera.lpr.enabled = False
        camera.face_recognition.enabled = False
        self.assertEqual(
            module.get_categorized_object_names(self.config, ["front"]),
            {"car": ["ups"]},
        )

    def test_face_discovery_handles_absent_or_unreadable_directory(self):
        self.assertEqual(module._get_face_names(), set())
        Path(module.FACE_DIR).mkdir()
        with patch.object(module.os, "listdir", side_effect=PermissionError):
            self.assertEqual(module._get_face_names(), set())

    def test_classification_combines_trained_and_dataset_labels_excluding_none(self):
        model = Path(module.MODEL_CACHE_DIR) / "vehicles"
        model.mkdir(parents=True)
        (model / "labelmap.txt").write_text("delivery\nnone\nfamily\n")
        dataset = Path(module.CLIPS_DIR) / "vehicles/dataset"
        dataset.mkdir(parents=True)
        for name in ("delivery", "work", "none"):
            (dataset / name).mkdir()
        (dataset / "ignore.txt").write_text("file")
        self.assertEqual(
            module._get_classification_categories("vehicles"),
            {"delivery", "family", "work"},
        )
        with patch.object(module, "load_labels", side_effect=OSError):
            self.assertEqual(
                module._get_classification_categories("vehicles"), {"delivery", "work"}
            )
        with patch.object(module.os, "listdir", side_effect=PermissionError):
            self.assertEqual(
                module._get_classification_categories("vehicles"),
                {"delivery", "family"},
            )
        self.assertEqual(module._get_classification_categories("not-trained"), set())

    def test_custom_models_require_enabled_sub_label_mode_and_visible_objects(self):
        def model(enabled=True, mode="sub_label", objects=None):
            return SimpleNamespace(
                enabled=enabled,
                object_config=SimpleNamespace(
                    classification_type=mode, objects=objects or ["car"]
                ),
            )

        self.config.classification.custom = {
            "disabled": model(False),
            "no-object": SimpleNamespace(enabled=True, object_config=None),
            "attribute": model(mode="attribute"),
            "empty": model(),
            "visible": model(),
            "hidden": model(objects=["dog"]),
        }
        with patch.object(
            module,
            "_get_classification_categories",
            side_effect=lambda key: set() if key == "empty" else {"delivery"},
        ):
            self.assertEqual(
                module.get_categorized_object_names(self.config, ["front"], "car"),
                {"car": ["Family", "delivery", "ups"]},
            )
            self.assertEqual(
                module.get_categorized_object_names(self.config, [], "car"), {}
            )
