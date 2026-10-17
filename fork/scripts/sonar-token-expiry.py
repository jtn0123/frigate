"""Warn before the SONAR_TOKEN secret expires, and fail once it has.

The token's expiry cannot be read from the secret, so the owner records it in
fork/sonar-token.env (SONAR_TOKEN_EXPIRES=YYYY-MM-DD or never) when rotating it.
The "sonar" job of "Fork - Checks" runs this before the scan: a GitHub Actions
warning from 14 days before the date. Once the date has passed it asks
SonarCloud whether the token in $SONAR_TOKEN still authenticates: if it does,
the token was rotated and only the date file was forgotten, which is a
warning; if it does not (or cannot be asked), an error and exit code 1, so the
failure names its cause, which the scanner's own authentication error does
not. Tokens with no fixed expiry are authenticated on every run because
SonarCloud can revoke them after 60 days of inactivity.

    python3 fork/scripts/sonar-token-expiry.py [path-to-env-file]
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

KEY = "SONAR_TOKEN_EXPIRES"
WARN_DAYS = 14
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "sonar-token.env"
ROTATE = (
    "Rotate the token and update the date in fork/sonar-token.env "
    "(steps: fork/README.md, Owner setup)"
)

_LINE = re.compile(rf"^{KEY}=(.*)$", re.MULTILINE)


def read_expiry(text: str) -> date | None:
    """Return the expiry date recorded in the env file's text.

    Args:
        text: Contents of fork/sonar-token.env

    Returns:
        The date on the single SONAR_TOKEN_EXPIRES line, or None for never

    Raises:
        ValueError: If the line is missing, repeated or not a date or never
    """
    matches = _LINE.findall(text)
    if len(matches) != 1:
        raise ValueError(f"expected exactly one {KEY}=YYYY-MM-DD or never line")
    value = matches[0].strip()
    if value == "never":
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError(f"expected {KEY}=YYYY-MM-DD or never")
    return date.fromisoformat(value)


def token_authenticates(token: str) -> bool | None:
    """Ask SonarCloud whether a token is still valid.

    Args:
        token: The SONAR_TOKEN secret

    Returns:
        True or False as SonarCloud answers, None when it cannot be asked
    """
    if not token:
        return None
    credentials = base64.b64encode(f"{token}:".encode()).decode()
    request = urllib.request.Request(
        "https://sonarcloud.io/api/authentication/validate",
        headers={"Authorization": f"Basic {credentials}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.load(response)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None
    valid = answer.get("valid") if isinstance(answer, dict) else None
    return valid if isinstance(valid, bool) else None


def check(
    expiry: date | None, today: date, token_valid: bool | None = None
) -> tuple[int, str]:
    """Return the exit code and the line to print for an expiry date.

    Args:
        expiry: The last day the token is valid, or None for no fixed expiry
        today: The current date
        token_valid: Whether the token still authenticates; checked after
            a fixed expiry or on every run for no fixed expiry

    Returns:
        Exit code and a workflow command or plain status line
    """
    if expiry is None:
        if token_valid:
            return 0, (
                "SONAR_TOKEN has no fixed expiry; authentication verified "
                "(revoked after 60 days of inactivity)"
            )
        return 1, (
            "::error title=SONAR_TOKEN authentication failed::The token has no "
            f"fixed expiry but could not be verified. {ROTATE}"
        )
    days = (expiry - today).days
    if days < 0 and token_valid:
        return 0, (
            f"::warning title=SONAR_TOKEN expiry date is stale::The documented "
            f"expiry {expiry.isoformat()} has passed but the token still "
            f"authenticates. Update the date in fork/sonar-token.env"
        )
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


def main(path: Path = DEFAULT_FILE) -> int:
    """Check the repository's env file (tests pass their own)."""
    try:
        expiry = read_expiry(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"::error title=SONAR_TOKEN expiry unknown::{path.name}: {err}")
        return 1
    today = date.today()
    token_valid = None
    if expiry is None or expiry < today:
        token_valid = token_authenticates(os.environ.get("SONAR_TOKEN", ""))
    code, line = check(expiry, today, token_valid)
    print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
