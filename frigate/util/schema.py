"""JSON schema utilities for Frigate."""

from typing import Any

from pydantic import BaseModel, TypeAdapter

_SCHEMA_DEFS_KEY = "$defs"


def get_config_schema(config_class: type[BaseModel]) -> dict[str, Any]:
    """
    Returns the JSON schema for FrigateConfig with polymorphic detectors.

    This utility patches the FrigateConfig schema to include the full polymorphic
    definitions for detectors. By default, Pydantic's schema for Dict[str, BaseDetectorConfig]
    only includes the base class fields. This function replaces it with a reference
    to the DetectorConfig union, which includes all available detector subclasses.
    """
    # Import here to ensure all detector plugins are loaded through the detectors module
    from frigate.detectors import DetectorConfig

    # Get the base schema for FrigateConfig
    schema = config_class.model_json_schema()

    # Get the schema for the polymorphic DetectorConfig union
    detector_adapter: TypeAdapter = TypeAdapter(DetectorConfig)
    detector_schema = detector_adapter.json_schema()

    # Ensure $defs exists in FrigateConfig schema
    if _SCHEMA_DEFS_KEY not in schema:
        schema[_SCHEMA_DEFS_KEY] = {}

    # Merge $defs from DetectorConfig into FrigateConfig schema
    # This includes the specific schemas for each detector plugin (OvDetectorConfig, etc.)
    if _SCHEMA_DEFS_KEY in detector_schema:
        schema[_SCHEMA_DEFS_KEY].update(detector_schema[_SCHEMA_DEFS_KEY])

    # Extract the union schema (oneOf/discriminator) and add it as a definition
    detector_union_schema = {
        k: v for k, v in detector_schema.items() if k != _SCHEMA_DEFS_KEY
    }
    schema[_SCHEMA_DEFS_KEY]["DetectorConfig"] = detector_union_schema

    # Update the 'detectors' property to use the polymorphic DetectorConfig definition
    if "detectors" in schema.get("properties", {}):
        schema["properties"]["detectors"]["additionalProperties"] = {
            "$ref": "#/$defs/DetectorConfig"
        }

    return schema
