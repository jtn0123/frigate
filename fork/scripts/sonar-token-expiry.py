"""Warn before the SONAR_TOKEN secret expires, and fail once it has.

The token's expiry cannot be read from the secret, so the owner records it in
fork/sonar-token.env (SONAR_TOKEN_EXPIRES=YYYY-MM-DD) when rotating the token.
The "sonar" job of "Fork - Checks" runs this before the scan: a GitHub Actions
warning from 14 days before the date, an error and exit code 1 once the date
has passed, so the failure names its cause, which the scanner's own
authentication error does not.

    python3 fork/scripts/sonar-token-expiry.py [path-to-env-file]
"""

import re
import sys
from datetime import date
from pathlib import Path

KEY = "SONAR_TOKEN_EXPIRES"
WARN_DAYS = 14
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "sonar-token.env"
ROTATE = (
    "Rotate the token and update the date in fork/sonar-token.env "
    "(steps: fork/README.md, Owner setup)"
)

_LINE = re.compile(rf"^{KEY}=(\d{{4}}-\d{{2}}-\d{{2}})\s*$", re.MULTILINE)


def read_expiry(text: str) -> date:
    """Return the expiry date recorded in the env file's text.

    Args:
        text: Contents of fork/sonar-token.env

    Returns:
        The date on the single SONAR_TOKEN_EXPIRES line

    Raises:
        ValueError: If the line is missing, repeated or not a real date
    """
    matches = _LINE.findall(text)
    if len(matches) != 1:
        raise ValueError(f"expected exactly one {KEY}=YYYY-MM-DD line")
    return date.fromisoformat(matches[0])


def check(expiry: date, today: date) -> tuple[int, str]:
    """Return the exit code and the line to print for an expiry date.

    Args:
        expiry: The last day the token is valid
        today: The current date

    Returns:
        Exit code (1 only when the expiry has passed) and a workflow command
        or plain status line
    """
    days = (expiry - today).days
    if days < 0:
        return 1, (
            f"::error title=SONAR_TOKEN expired::The documented expiry "
            f"{expiry.isoformat()} has passed. {ROTATE}"
        )
    if days <= WARN_DAYS:
        return 0, (
            f"::warning title=SONAR_TOKEN expires soon::{days} day(s) left, "
            f"until {expiry.isoformat()}. {ROTATE}"
        )
    return 0, f"SONAR_TOKEN expires {expiry.isoformat()}, in {days} days"


def main(argv: list[str]) -> int:
    """Check the env file named in argv, or the repository's."""
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_FILE
    try:
        expiry = read_expiry(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"::error title=SONAR_TOKEN expiry unknown::{path.name}: {err}")
        return 1
    code, line = check(expiry, date.today())
    print(line)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
