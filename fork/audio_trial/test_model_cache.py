"""Check immutable model resolution, corruption detection, and offline failures."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import model_cache


class ModelCacheTests(unittest.TestCase):
    def test_pinned_snapshot_detects_corruption_even_with_cached_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            weights = root / "snapshot"
            weights.mkdir()
            file = weights / "model.bin"
            file.write_bytes(b"good")
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "medium": {
                            "path": "snapshot",
                            "files": {
                                "model.bin": {
                                    "sha256": hashlib.sha256(b"good").hexdigest()
                                }
                            },
                        }
                    }
                )
            )
            with patch.object(model_cache, "MANIFEST", manifest):
                self.assertEqual(
                    model_cache.resolve_model("medium", root, root), str(weights)
                )
                with patch.object(model_cache.hashlib, "file_digest") as digest:
                    model_cache.resolve_model("medium", root, root)
                    digest.assert_not_called()
                file.write_bytes(b"evil")
                with self.assertRaisesRegex(ValueError, "integrity"):
                    model_cache.resolve_model("medium", root, root)
                file.unlink()
                with self.assertRaises(FileNotFoundError):
                    model_cache.resolve_model("medium", root, root)
