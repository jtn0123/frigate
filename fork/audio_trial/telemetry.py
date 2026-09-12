"""Publish transcript-free model measurements for Frigate's admin dashboard."""

import json
import os
import time
from importlib.util import find_spec
from pathlib import Path

import psutil

STAGE_FILE = Path("/state/stages.json")
MODEL_ROOTS = {
    "medium": Path("/models/whisper/models--Systran--faster-whisper-medium"),
    "large-v3": Path("/models/whisper/models--Systran--faster-whisper-large-v3"),
    "clap": Path(os.environ.get("CLAP_MODEL", "/missing")),
}
whisper_spec = find_spec("faster_whisper")
if whisper_spec and whisper_spec.origin:
    MODEL_ROOTS["vad"] = Path(whisper_spec.origin).parent / "assets"


def atomic_json(path: Path, data: dict) -> None:
    """Replace a complete snapshot so readers never see a partial write."""
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(path)


class Stage:
    """Measure stage duration and process memory without claiming model-only RSS."""

    def __init__(self, model: str, loading: bool = False):
        self.model = model
        self.loading = loading

    def __enter__(self):
        self.started = time.monotonic()
        self.data = (
            json.loads(STAGE_FILE.read_text())
            if STAGE_FILE.exists()
            else {"models": {}}
        )
        self.data.update(
            {"active": self.model, "status": "loading" if self.loading else "busy"}
        )
        atomic_json(STAGE_FILE, self.data)
        return self

    def __exit__(self, error_type, *_):
        metrics = self.data["models"].setdefault(self.model, {})
        if error_type is None:
            metrics["load_ms" if self.loading else "latency_ms"] = (
                time.monotonic() - self.started
            ) * 1000
            if not self.loading:
                metrics["last_used"] = time.time()
        metrics["peak_ram_bytes"] = max(
            metrics.get("peak_ram_bytes", 0), psutil.Process().memory_info().rss
        )
        self.data.update({"active": None, "status": "cached"})
        atomic_json(STAGE_FILE, self.data)


class Telemetry:
    """Sample a single inference process and publish bounded queue counters."""

    def __init__(self, directory: Path):
        self.path = directory / "models.json"
        directory.mkdir(parents=True, exist_ok=True)
        self.models = {}
        self.disk_checked = 0
        self.process = None
        self.active = None
        self.state = "cached"
        self.queue = {}
        self.available = None
        self.pause_reason = ""
        self.oldest_wait = 0
        if self.path.exists():
            try:
                self.models = json.loads(self.path.read_text()).get("models", {})
            except (OSError, ValueError):
                pass
        for entry in self.models.values():
            entry.update({"status": "cached", "ram_bytes": 0, "cpu_percent": 0})

    def sample(self, pid: int | None = None) -> None:
        """Capture live process CPU/RAM and completed per-stage timings."""
        try:
            stages = json.loads(STAGE_FILE.read_text())
            for name, values in stages.get("models", {}).items():
                entry = self.models.setdefault(name, {})
                peak = max(
                    entry.get("peak_ram_bytes", 0), values.get("peak_ram_bytes", 0)
                )
                entry.update(values)
                entry["peak_ram_bytes"] = peak
            self.active = stages.get("active") if pid else None
            self.state = stages.get("status", "cached")
        except (OSError, ValueError):
            self.active = None
        for entry in self.models.values():
            entry.update(
                {
                    "status": "cached",
                    "ram_bytes": 0,
                    "cpu_percent": 0,
                    "gpu_memory_bytes": 0,
                }
            )
        if pid:
            try:
                if self.process is None or self.process.pid != pid:
                    self.process = psutil.Process(pid)
                    self.process.cpu_percent()
                rss = self.process.memory_info().rss
                cpu = self.process.cpu_percent()
                if self.active:
                    entry = self.models.setdefault(self.active, {})
                    entry.update(
                        {"status": self.state, "ram_bytes": rss, "cpu_percent": cpu}
                    )
                    entry["peak_ram_bytes"] = max(entry.get("peak_ram_bytes", 0), rss)
            except psutil.Error:
                self.active = None
        else:
            self.process = None
        self.publish()

    def publish(self) -> None:
        """Write only model metrics and aggregate queue data, never event text."""
        if time.monotonic() - self.disk_checked > 60:
            for name, root in MODEL_ROOTS.items():
                entry = self.models.setdefault(name, {})
                try:
                    # Deduplicate HF snapshot symlinks by resolved file path.
                    paths = (
                        {root.resolve()}
                        if root.is_file()
                        else {p.resolve() for p in root.rglob("*") if p.is_file()}
                    )
                    entry["disk_bytes"] = (
                        sum(p.stat().st_size for p in paths) if root.exists() else None
                    )
                except OSError:
                    entry["disk_bytes"] = None
                if not root.exists():
                    entry["status"] = "missing"
            self.disk_checked = time.monotonic()
        atomic_json(
            self.path,
            {
                "updated": time.time(),
                "models": self.models,
                "queue": self.queue,
                "available_bytes": self.available,
                "pause_reason": self.pause_reason,
                "oldest_wait_seconds": self.oldest_wait,
            },
        )
