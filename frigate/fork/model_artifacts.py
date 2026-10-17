"""Immutable, verified data artifacts for the Jina embedding models.

The manifest records reviewed public Hugging Face revisions and SHA-256 hashes.
Tokenizers use Transformers' built-in classes and never execute repository code.
"""

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import requests

PINS = json.loads(Path(__file__).with_name("model-artifacts.json").read_text())


def artifact_urls(model: str, files: list[str]) -> dict[str, str]:
    """Return immutable URLs, also verifying the configured mirror uses HTTPS."""
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
    parsed = urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None:
        raise ValueError("HF_ENDPOINT must be an HTTPS URL without credentials")
    pin = PINS[model]
    return {
        name: f"{endpoint}/{model}/resolve/{pin['revision']}/{pin['files'][name]['path']}"
        for name in files
    }


def artifact_cache_path(root: str, model: str) -> str:
    """Separate verified artifacts from the historical mutable cache."""
    return str(Path(root) / model / PINS[model]["revision"])


def verify_artifact(model: str, name: str, path: str | Path) -> None:
    """Reject missing or changed artifacts before a model loader sees them."""
    digest = hashlib.sha256()
    with open(path, "rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != PINS[model]["files"][name]["sha256"]:
        raise ValueError(f"Model artifact integrity check failed for {model}/{name}")


def download_artifact(model: str, name: str, path: str | Path) -> None:
    """Publish a downloaded file only after its pinned hash is verified."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        url = artifact_urls(model, [name])[name]
        with requests.get(url, stream=True, timeout=(15, 60)) as response:
            response.raise_for_status()
            with temporary.open("wb") as artifact:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    artifact.write(chunk)
                artifact.flush()
                os.fsync(artifact.fileno())
        verify_artifact(model, name, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def tokenizer_files(model: str) -> list[str]:
    """List the pinned, nonexecutable tokenizer inputs for a model."""
    return [
        name
        for name in PINS[model]["files"]
        if name.startswith("tokenizer")
        or name in ("special_tokens_map.json", "vocab.txt")
    ]


def download_tokenizer(model: str, path: str) -> None:
    """Atomically publish a complete tokenizer directory without remote code."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(dir=destination.parent))
    try:
        for name in tokenizer_files(model):
            download_artifact(model, name, temporary / name)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def verified_tokenizer_path(model: str, cache: str) -> str:
    """Verify all tokenizer data before loading it with local_files_only."""
    path = Path(cache) / "tokenizer"
    for name in tokenizer_files(model):
        verify_artifact(model, name, path / name)
    return str(path)
