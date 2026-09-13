"""Resolve immutable model snapshots and detect missing or changed cached weights."""

import hashlib
import json
import os
from pathlib import Path

MANIFEST = Path(__file__).with_name("models.lock.json")


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
    fingerprint = {}
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
    record = {"files": files, "fingerprint": fingerprint, "snapshot": str(snapshot)}
    cache = state / f"integrity-{name}.json"
    try:
        previous = json.loads(cache.read_text())
    except (OSError, ValueError):
        previous = None
    if previous != record:
        for relative, metadata in files.items():
            expected = metadata["sha256"]
            with (snapshot / relative).open("rb") as source:
                actual = hashlib.file_digest(source, "sha256").hexdigest()
            if actual != expected:
                raise ValueError("Model cache integrity mismatch")
        # This cache is only an optimization. Read-only state never bypasses hashes.
        try:
            state.mkdir(parents=True, exist_ok=True)
            temporary = cache.with_suffix(".tmp")
            temporary.write_text(json.dumps(record))
            temporary.replace(cache)
        except OSError:
            pass
    return str(snapshot)
