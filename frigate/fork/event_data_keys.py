"""Fork (I53): event data keys the search endpoints pass through.

Custom classification models of the attribute type write their verdict to
``Event.data[<model name>]`` and the score beside it. The search and
explore endpoints copy only a fixed list of data keys into their responses,
so with a query typed the detail dialog showed those attributes as unset.
"""

from frigate.config import FrigateConfig


def custom_attribute_keys(config: FrigateConfig) -> list[str]:
    """The data keys attribute-type custom models write, with their scores."""
    keys: list[str] = []
    for name, model in config.classification.custom.items():
        objects = model.object_config
        if objects is not None and objects.classification_type.value == "attribute":
            keys.append(name)
            keys.append(f"{name}_score")
    return keys
