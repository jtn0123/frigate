"""Generate unpredictable identifiers with the existing lowercase ID alphabet."""

import secrets
import string

_ID_ALPHABET = string.ascii_lowercase + string.digits


def random_id(length: int = 6) -> str:
    """Return an ID suffix; callers provide their existing timestamp or prefix."""
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(length))
