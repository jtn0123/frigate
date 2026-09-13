"""Persist bounded request lifecycle metadata without prompts or model output."""

import json
import logging
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from frigate.const import MODEL_CACHE_DIR

DIRECTORY = Path(MODEL_CACHE_DIR) / "generation-requests"
logger = logging.getLogger(__name__)


def write_request(identifier: str, data: dict) -> None:
    """Best-effort atomic writes; retain at most 1000 requests for one day."""
    temporary = DIRECTORY / (identifier + ".tmp")
    try:
        DIRECTORY.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(data))
        temporary.replace(DIRECTORY / (identifier + ".json"))
        files = sorted(
            DIRECTORY.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )
        for index, path in enumerate(files):
            if index >= 1000 or path.stat().st_mtime < time.time() - 86400:
                path.unlink(missing_ok=True)
    except OSError:
        logger.debug("Request lifecycle telemetry unavailable")
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


@contextmanager
def generation_request(image_count: int) -> Iterator[None]:
    """Record actual start/end times, including failed calls, across processes."""
    identifier = uuid.uuid4().hex
    data = {
        "id": identifier,
        "started": time.time(),
        "ended": None,
        "images": image_count,
        "status": "running",
    }
    write_request(identifier, data)
    try:
        yield
    except BaseException:
        data["status"] = "failed"
        raise
    else:
        data["status"] = "complete"
    finally:
        data["ended"] = time.time()
        write_request(identifier, data)
