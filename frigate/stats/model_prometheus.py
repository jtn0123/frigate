"""Export sanitized background model samples without a shared request registry."""

import time

from prometheus_client import CollectorRegistry, Gauge, generate_latest

from frigate.stats.ai_models import number


def model_metrics(sample: dict | None) -> bytes:
    """Expose absent/stale samples explicitly and omit unknown numeric values."""
    registry = CollectorRegistry()
    fresh = bool(
        sample
        and number(sample.get("updated")) is not None
        and 0 <= time.time() - sample["updated"] <= 90
    )
    Gauge(
        "frigate_ai_sample_fresh", "Background AI sample is recent", registry=registry
    ).set(int(fresh))
    if not fresh or sample is None:
        return generate_latest(registry)
    for field in (
        "ram_bytes",
        "cpu_percent",
        "gpu_memory_bytes",
        "latency_ms",
        "disk_bytes",
    ):
        gauge = Gauge(
            "frigate_ai_model_" + field,
            "Model measurement with explicit resource attribution",
            ["model", "scope"],
            registry=registry,
        )
        for model in sample["models"]:
            value = number(model.get(field))
            if value is not None and model["status"] not in {
                "stale",
                "unavailable",
                "unknown",
            }:
                gauge.labels(model["id"], model["resource_scope"]).set(value)
    for field in ("pending", "failed", "expired", "oldest_wait_seconds"):
        gauge = Gauge(
            "frigate_ai_queue_" + field, "Audio queue " + field, registry=registry
        )
        value = number(sample["audio"].get(field))
        if sample["audio"].get("status") == "connected" and value is not None:
            gauge.set(value)
        else:
            registry.unregister(gauge)
    return generate_latest(registry)
