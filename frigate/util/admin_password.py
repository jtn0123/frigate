"""Private delivery of generated administrator credentials."""

import logging
from pathlib import Path

from frigate.util.atomic import write_private_file

logger = logging.getLogger(__name__)


def save_admin_password(password: str, config_dir: Path) -> Path:
    """Save a password privately before changing the administrator account.

    Atomic replacement avoids following existing links or retaining permissive
    access modes. Write errors stop setup before changing the account.
    """
    destination = config_dir / "admin_password"
    write_private_file(destination, password + "\n")
    return destination


def remove_admin_password(config_dir: Path) -> None:
    """Remove the bootstrap credential after a successful password change."""
    try:
        (config_dir / "admin_password").unlink(missing_ok=True)
    except OSError:
        # The password has already changed. Do not report the update as failed.
        logger.warning(
            "Admin password changed, but the generated credential file could not "
            "be removed; remove %s/admin_password manually",
            config_dir,
        )
