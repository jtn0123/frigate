"""Count failed logins using the application's shared rate-limit storage."""

from limits import parse_many
from slowapi import Limiter
from starlette.responses import JSONResponse


def check_login_budget(
    limiter: Limiter, limit: str, client: str, *, failed: bool = False
) -> JSONResponse | None:
    """Check before password work, charging the budget only on failure.

    The storage's atomic hit also rejects concurrent failures beyond the limit.
    Successful logins do not start a window or consume any allowance.
    """
    if not limiter.enabled:
        return None
    strategy = limiter.limiter
    operation = strategy.hit if failed else strategy.test
    for item in parse_many(limit):
        if not operation(item, client, "frigate.login.failed"):
            return JSONResponse(
                content={"error": f"Rate limit exceeded: {item}"}, status_code=429
            )
    return None
