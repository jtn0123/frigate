"""Map config section keys to Settings UI navigation paths."""

_GLOBAL_CONFIGURATION = "Global configuration"
_CAMERA_CONFIGURATION = "Camera configuration"

# Derived from web/src/pages/Settings.tsx section mappings
# and web/public/locales/en/views/settings.json menu labels.
#
# Format: section_key -> (group_label, page_label)
# Navigation path: "Settings > {group_label} > {page_label}"

GLOBAL_NAV: dict[str, tuple[str, str]] = {
    "detect": (_GLOBAL_CONFIGURATION, "Object detection"),
    "ffmpeg": (_GLOBAL_CONFIGURATION, "FFmpeg"),
    "record": (_GLOBAL_CONFIGURATION, "Recording"),
    "snapshots": (_GLOBAL_CONFIGURATION, "Snapshots"),
    "motion": (_GLOBAL_CONFIGURATION, "Motion detection"),
    "objects": (_GLOBAL_CONFIGURATION, "Objects"),
    "review": (_GLOBAL_CONFIGURATION, "Review"),
    "audio": (_GLOBAL_CONFIGURATION, "Audio events"),
    "live": (_GLOBAL_CONFIGURATION, "Live playback"),
    "timestamp_style": (_GLOBAL_CONFIGURATION, "Timestamp style"),
    "notifications": ("Notifications", "Notifications"),
}

CAMERA_NAV: dict[str, tuple[str, str]] = {
    "detect": (_CAMERA_CONFIGURATION, "Object detection"),
    "ffmpeg": (_CAMERA_CONFIGURATION, "FFmpeg"),
    "record": (_CAMERA_CONFIGURATION, "Recording"),
    "snapshots": (_CAMERA_CONFIGURATION, "Snapshots"),
    "motion": (_CAMERA_CONFIGURATION, "Motion detection"),
    "objects": (_CAMERA_CONFIGURATION, "Objects"),
    "review": (_CAMERA_CONFIGURATION, "Review"),
    "audio": (_CAMERA_CONFIGURATION, "Audio events"),
    "audio_transcription": (_CAMERA_CONFIGURATION, "Audio transcription"),
    "notifications": (_CAMERA_CONFIGURATION, "Notifications"),
    "live": (_CAMERA_CONFIGURATION, "Live playback"),
    "birdseye": (_CAMERA_CONFIGURATION, "Birdseye"),
    "face_recognition": (_CAMERA_CONFIGURATION, "Face recognition"),
    "lpr": (_CAMERA_CONFIGURATION, "License plate recognition"),
    "mqtt": (_CAMERA_CONFIGURATION, "MQTT"),
    "onvif": (_CAMERA_CONFIGURATION, "ONVIF"),
    "ui": (_CAMERA_CONFIGURATION, "Camera UI"),
    "timestamp_style": (_CAMERA_CONFIGURATION, "Timestamp style"),
}

ENRICHMENT_NAV: dict[str, tuple[str, str]] = {
    "semantic_search": ("Enrichments", "Semantic search"),
    "genai": ("Enrichments", "Generative AI"),
    "face_recognition": ("Enrichments", "Face recognition"),
    "lpr": ("Enrichments", "License plate recognition"),
    "classification": ("Enrichments", "Object classification"),
    "audio_transcription": ("Enrichments", "Audio transcription"),
}

SYSTEM_NAV: dict[str, tuple[str, str]] = {
    "go2rtc_streams": ("System", "go2rtc streams"),
    "database": ("System", "Database"),
    "mqtt": ("System", "MQTT"),
    "tls": ("System", "TLS"),
    "auth": ("System", "Authentication"),
    "networking": ("System", "Networking"),
    "proxy": ("System", "Proxy"),
    "ui": ("System", "UI"),
    "logger": ("System", "Logging"),
    "environment_vars": ("System", "Environment variables"),
    "telemetry": ("System", "Telemetry"),
    "birdseye": ("System", "Birdseye"),
    "detectors": ("System", "Detectors and model"),
    "model": ("System", "Detectors and model"),
}

# All known top-level config section keys
ALL_CONFIG_SECTIONS = (
    set(GLOBAL_NAV)
    | set(CAMERA_NAV)
    | set(ENRICHMENT_NAV)
    | set(SYSTEM_NAV)
    | {"cameras"}
)


def get_nav_path(section_key: str, level: str = "global") -> str | None:
    """Get the full navigation path for a config section.

    Args:
        section_key: Config section key (e.g., "record")
        level: "global", "camera", "enrichment", or "system"

    Returns:
        NavPath string like "Settings > Global configuration > Recording",
        or None if not found.
    """
    nav_tables = {
        "global": GLOBAL_NAV,
        "camera": CAMERA_NAV,
        "enrichment": ENRICHMENT_NAV,
        "system": SYSTEM_NAV,
    }

    table = nav_tables.get(level)
    if table is None:
        return None

    entry = table.get(section_key)
    if entry is None:
        return None

    group, page = entry
    return f"Settings > {group} > {page}"


def detect_level(section_key: str) -> str:
    """Detect whether a config section is global, camera, enrichment, or system."""
    if section_key in SYSTEM_NAV:
        return "system"
    if section_key in ENRICHMENT_NAV:
        return "enrichment"
    if section_key in GLOBAL_NAV:
        return "global"
    if section_key in CAMERA_NAV:
        return "camera"
    return "global"
