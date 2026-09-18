"""Resolve immutable model snapshots and detect missing or changed cached weights."""

import hashlib
import json
import os
import time
from pathlib import Path

MANIFEST = Path(__file__).with_name("models.lock.json")
# A file rewritten within the same timestamp tick as the last verification can
# keep its size, inode and both times, so its fingerprint proves nothing yet
# (git calls these entries racy). Until a verification is this much newer than
# every file it covers, the hashes are checked again.
RACY_WINDOW_NS = 2_000_000_000


def _fingerprint(snapshot: Path, root: Path, files: dict) -> tuple[dict, int]:
    """Return each file's metadata and the newest timestamp among them."""
    fingerprint = {}
    newest_ns = 0
    for relative in files:
        path = snapshot / relative
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Model cache path escapes model root")
        stat = path.stat()
        fingerprint[relative] = [
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
            stat.st_ino,
        ]
        newest_ns = max(newest_ns, stat.st_mtime_ns, stat.st_ctime_ns)
    return fingerprint, newest_ns


def _cached_validation_holds(cache: Path, record: dict, newest_ns: int) -> bool:
    """Tell whether an earlier verification still vouches for these files."""
    try:
        previous = json.loads(cache.read_text())
    except (OSError, ValueError):
        return False
    if not isinstance(previous, dict):
        return False
    verified_ns = previous.pop("verified_ns", 0)
    if not isinstance(verified_ns, int):
        return False
    return previous == record and verified_ns - newest_ns >= RACY_WINDOW_NS


def _verify_hashes(snapshot: Path, files: dict) -> None:
    """Raise unless every file matches the manifest's SHA-256."""
    for relative, metadata in files.items():
        with (snapshot / relative).open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != metadata["sha256"]:
            raise ValueError("Model cache integrity mismatch")


def resolve_model(
    name: str, root: Path | None = None, state: Path | None = None
) -> str:
    """Verify content on first use or metadata change, then use the pinned snapshot."""
    root = root or Path(os.environ.get("MODEL_ROOT", "/models"))
    state = state or Path(os.environ.get("STATE_DIR", "/state"))
    entry = json.loads(MANIFEST.read_text())[name]
    snapshot = root / entry["path"]
    files = entry["files"]
    if not files:
        raise ValueError("Empty model integrity manifest")
    fingerprint, newest_ns = _fingerprint(snapshot, root, files)
    record = {"files": files, "fingerprint": fingerprint, "snapshot": str(snapshot)}
    cache = state / f"integrity-{name}.json"
    if not _cached_validation_holds(cache, record, newest_ns):
        _verify_hashes(snapshot, files)
        # This cache is only an optimization. Read-only state never bypasses hashes.
        try:
            state.mkdir(parents=True, exist_ok=True)
            temporary = cache.with_suffix(".tmp")
            temporary.write_text(json.dumps({**record, "verified_ns": time.time_ns()}))
            temporary.replace(cache)
        except OSError:
            pass
    return str(snapshot)
