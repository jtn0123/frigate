"""Dataset labels must not select directories outside the export folder."""

import importlib.util
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase

_SCRIPT = Path(__file__).resolve().parents[2] / "testing-scripts/object_dataset.py"
_SPEC = importlib.util.spec_from_file_location("dataset_export_test_module", _SCRIPT)
_DATASET = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _DATASET
_SPEC.loader.exec_module(_DATASET)


class TestDatasetExportPaths(TestCase):
    def test_parent_segments_in_labels_stay_inside_export_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sample.png"
            source.write_bytes(b"image")
            output = root / "export"
            sample = SimpleNamespace(
                path=str(source),
                true_label="../escaped",
                pred_label="dog",
                pred_score=0.9,
            )
            _DATASET.save_misclassified([sample], str(output))
            copies = list(output.rglob("*.png"))
            self.assertEqual(len(copies), 1)
            self.assertEqual(copies[0].parent.name, "..%2Fescaped__as__dog")
            self.assertFalse((root / "escaped__as__dog").exists())

    def test_ordinary_labels_preserve_existing_bucket_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sample.png"
            source.write_bytes(b"image")
            output = root / "export"
            sample = SimpleNamespace(
                path=str(source), true_label="cat", pred_label="dog", pred_score=0.9
            )
            _DATASET.save_misclassified([sample], str(output))
            self.assertEqual(
                (output / "cat__as__dog/090_sample.png").read_bytes(), b"image"
            )
