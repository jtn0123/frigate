"""Attach safe failure stages and causes without exposing clip URLs or model text."""

import json
import subprocess
import urllib.error
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class AudioFailure(RuntimeError):
    """A fixed stage and cause suitable for logs and operator status."""

    def __init__(self, stage: str, cause: str) -> None:
        self.stage = stage
        self.cause = cause
        super().__init__(f"{stage}: {cause}")


def cause(error: BaseException) -> str:
    """Classify known operational failures without returning arbitrary messages."""
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        return "timeout"
    if isinstance(error, urllib.error.HTTPError):
        return "http_error"
    if str(error).startswith("inference exited "):
        return "process_exit"
    known = {
        "camera processing needs priority": "camera_priority",
        "worker stopping": "shutdown",
        "inference time limit": "timeout",
        "clip download limit": "download_limit",
        "memory reserve low": "memory_reserve",
    }
    return known.get(
        str(error),
        "process_exit"
        if isinstance(error, subprocess.CalledProcessError)
        else "unavailable",
    )


@contextmanager
def stage(name: str) -> Iterator[None]:
    """Preserve a sanitized stage at each download/conversion/model boundary."""
    try:
        yield
    except AudioFailure:
        raise
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise AudioFailure(name, cause(error)) from error


def save_failure(state: Path, error: BaseException, now: float) -> dict[str, Any]:
    """Write an atomic, private-content-free failure report."""
    data = {
        "updated": now,
        "stage": getattr(error, "stage", "worker"),
        "cause": getattr(error, "cause", cause(error)),
    }
    target = state / "last-failure.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(target)
    return data
