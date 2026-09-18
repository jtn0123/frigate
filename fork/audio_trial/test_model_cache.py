"""Check immutable model resolution, corruption detection, and offline failures."""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import model_cache


def write_snapshot(root: Path) -> tuple[Path, Path, Path]:
    """Create a one-file snapshot and its manifest under root."""
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
                        "model.bin": {"sha256": hashlib.sha256(b"good").hexdigest()}
                    },
                }
            }
        )
    )
    return weights, file, manifest


class ModelCacheTests(unittest.TestCase):
    def test_pinned_snapshot_detects_corruption_even_with_cached_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            weights, file, manifest = write_snapshot(root)
            # The verification is recorded well after the file's timestamps,
            # as it is for a model that was downloaded before the service ran.
            later = model_cache.time.time_ns() + 10 * model_cache.RACY_WINDOW_NS
            with (
                patch.object(model_cache, "MANIFEST", manifest),
                patch.object(model_cache.time, "time_ns", return_value=later),
            ):
                self.assertEqual(
                    model_cache.resolve_model("medium", root, root), str(weights)
                )
                with patch.object(model_cache.hashlib, "file_digest") as digest:
                    model_cache.resolve_model("medium", root, root)
                    digest.assert_not_called()
                file.write_bytes(b"evil")
                # Same size and inode: make sure the rewrite shows in the
                # fingerprint on a filesystem with coarse timestamps too.
                changed = file.stat().st_mtime_ns + 1_000_000_000
                os.utime(file, ns=(changed, changed))
                with self.assertRaisesRegex(ValueError, "integrity"):
                    model_cache.resolve_model("medium", root, root)
                file.unlink()
                with self.assertRaises(FileNotFoundError):
                    model_cache.resolve_model("medium", root, root)

    def test_same_tick_rewrite_is_caught_by_rehashing_a_fresh_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _weights, file, manifest = write_snapshot(root)
            with patch.object(model_cache, "MANIFEST", manifest):
                model_cache.resolve_model("medium", root, root)
                before = file.stat()
                file.write_bytes(b"evil")
                # The worst case: the rewrite leaves every recorded time as
                # it was, so only the content differs.
                os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns))
                with self.assertRaisesRegex(ValueError, "integrity"):
                    model_cache.resolve_model("medium", root, root)

    def test_a_cache_without_a_verification_time_is_not_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _weights, _file, manifest = write_snapshot(root)
            with patch.object(model_cache, "MANIFEST", manifest):
                model_cache.resolve_model("medium", root, root)
                cache = root / "integrity-medium.json"
                record = json.loads(cache.read_text())
                del record["verified_ns"]
                cache.write_text(json.dumps(record))
                with patch.object(
                    model_cache.hashlib,
                    "file_digest",
                    wraps=model_cache.hashlib.file_digest,
                ) as digest:
                    model_cache.resolve_model("medium", root, root)
                    digest.assert_called()
