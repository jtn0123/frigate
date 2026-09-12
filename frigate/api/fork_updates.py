"""Fork: update notices and release notes from the fork's GitHub releases."""

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import allow_any_authenticated
from frigate.api.defs.tags import Tags
from frigate.fork.updates import FORK_REPO, get_checker
from frigate.version import VERSION

router = APIRouter(tags=[Tags.app])


def disabled_state() -> dict[str, Any]:
    return {
        "status": "disabled",
        "repo": FORK_REPO,
        "current_version": VERSION,
        "current_sha": None,
        "current_tag": None,
        "latest_tag": None,
        "newer_count": 0,
        "releases": [],
        "checked_at": None,
        "error": None,
    }


@router.get("/fork/updates", dependencies=[Depends(allow_any_authenticated())])
def fork_updates(request: Request, refresh: bool = False) -> JSONResponse:
    """Compare the running build with the fork's releases.

    Honors `telemetry.version_check: false` by never contacting GitHub. Only
    admins can force a refetch with `refresh=true`.
    """
    if not request.app.frigate_config.telemetry.version_check:
        return JSONResponse(content=disabled_state())

    force = refresh and request.headers.get("remote-role") == "admin"
    return JSONResponse(content=get_checker().state(force=force))
