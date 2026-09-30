"""Read the scene name the fork used before upstream's free-form scenes.

B18 shipped scenes as a fixed list whose catch-all was `all`, and its config
migration wrote `scene: all` into every migrated config. Upstream #24508 made
scenes free-form names with a catch-all of `default`, so a saved `all` would
name a scene of its own and leave cameras without a fallback model. `all` is
read as `default` instead, for models and cameras alike, and the next save
from the UI writes `default`.
"""

from typing import Any

LEGACY_DEFAULT_SCENE = "all"


def read_legacy_scene(value: Any) -> Any:
    """Map the legacy catch-all scene to the current default scene."""
    # imported here because detector_config imports this module
    from frigate.detectors.detector_config import DEFAULT_SCENE

    return DEFAULT_SCENE if value == LEGACY_DEFAULT_SCENE else value
