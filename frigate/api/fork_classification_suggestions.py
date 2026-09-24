"""Fork (I41): suggested dataset classes for a custom model's train images."""

import asyncio
import logging
from pathlib import Path
from typing import Any

import aiohttp
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from frigate.api.auth import require_role
from frigate.api.defs.request.fork_classification_suggestions_body import (
    ConfirmSuggestionBody,
)
from frigate.api.defs.response.fork_classification_suggestions_response import (
    ClassificationSuggestionsResponse,
    ConfirmSuggestionResponse,
    SuggestionReportResponse,
)
from frigate.api.defs.tags import Tags
from frigate.config import FrigateConfig
from frigate.const import CLIPS_DIR
from frigate.fork import classification_suggestions as suggest
from frigate.models import Event

logger = logging.getLogger(__name__)

router = APIRouter(tags=[Tags.classification])

# Provider requests for one page of the grid run a few at a time.


def unknown_model(name: str) -> JSONResponse:
    return JSONResponse(
        content={
            "success": False,
            "message": f"{name} is not a known classification model.",
        },
        status_code=404,
    )


def dataset_classes(name: str) -> list[str]:
    """The model's dataset folders, which are its classes."""
    return suggest.dataset_classes(CLIPS_DIR, name)


def load_events(ids: list[str]) -> list[dict[str, Any]]:
    return list(
        Event.select(Event.id, Event.camera, Event.label, Event.data)
        .where(Event.id << ids)
        .dicts()
    )


def state(app: Any, config: FrigateConfig) -> tuple[Any, Any]:
    """The answer cache and daily budget, created once beside the database."""
    cache = getattr(app, "fork_suggestion_cache", None)
    budget = getattr(app, "fork_suggestion_budget", None)
    if cache is None or budget is None:
        cache, budget = suggest.open_state(Path(config.database.path).parent)
        app.fork_suggestion_cache = cache
        app.fork_suggestion_budget = budget
    return cache, budget


make_ask = suggest.make_ask


@router.get(
    "/classification/{name}/suggestions",
    response_model=ClassificationSuggestionsResponse,
    dependencies=[Depends(require_role(["admin"]))],
    summary="Suggest dataset classes for train images",
    description="""Drafts a dataset class for each listed event from its description,
    locally and optionally through Jev. Drafts are for a person to confirm; nothing is
    labeled by this call.""",
)
async def classification_suggestions(
    request: Request, name: str, ids: str = ""
) -> JSONResponse:
    config: FrigateConfig = request.app.frigate_config
    if name not in config.classification.custom:
        return unknown_model(name)

    settings = config.classification.suggestions
    wanted: list[str] = []
    for item in ids.split(","):
        item = item.strip()
        if item and item not in wanted:
            wanted.append(item)
    wanted = wanted[: suggest.MAX_EVENTS]

    classes = await asyncio.to_thread(dataset_classes, name)
    events = await asyncio.to_thread(load_events, wanted) if wanted else []

    key = suggest.api_key()
    jev_config = settings.jev
    jev_on = settings.enabled and jev_config.enabled and bool(key)
    cache, budget = state(request.app, config)
    jev_settings: suggest.JevSettings | None = None
    if jev_on:
        jev_settings = {
            "model": jev_config.model,
            "cameras": list(jev_config.cameras),
            "daily_request_limit": jev_config.daily_request_limit,
        }

    if jev_settings is not None:
        async with aiohttp.ClientSession() as session:
            ask = make_ask(session, jev_config.url, key, jev_config.timeout)
            suggestions = await suggest.suggest_for_events(
                events, classes, settings.enabled, jev_settings, cache, budget, ask
            )
    else:
        suggestions = await suggest.suggest_for_events(
            events, classes, settings.enabled, None, None, None, None
        )

    used = await asyncio.to_thread(budget.used)
    return JSONResponse(
        content={
            "model": name,
            "classes": classes,
            "jev": {
                "enabled": settings.enabled and jev_config.enabled,
                "configured": bool(key),
                "used_today": used,
                "daily_request_limit": jev_config.daily_request_limit,
            },
            "suggestions": suggestions,
        }
    )


def confirm(
    name: str, body: ConfirmSuggestionBody, category: str
) -> tuple[list[str], str | None]:
    """Move the files and record why, on a worker thread."""
    event = (
        Event.select(Event.camera, Event.data)
        .where(Event.id == body.event_id)
        .dicts()
        .first()
    )
    description = ((event or {}).get("data") or {}).get("description")
    moved = suggest.categorize_train_files(
        CLIPS_DIR, name, category, list(dict.fromkeys(body.training_files))
    )
    suggest.record_confirmation(
        CLIPS_DIR,
        name,
        {
            "event_id": body.event_id,
            "camera": (event or {}).get("camera"),
            "category": category,
            "suggested_category": body.suggested_category,
            "source": body.source,
            "score": body.score,
            "accepted": body.suggested_category is not None
            and suggest.normalize_class(body.suggested_category)
            == suggest.normalize_class(category),
            "description_sha256": suggest.description_sha256(description)
            if isinstance(description, str) and description.strip()
            else None,
            "files": moved,
        },
    )
    return moved, None


@router.post(
    "/classification/{name}/suggestions/confirm",
    response_model=ConfirmSuggestionResponse,
    dependencies=[Depends(require_role(["admin"]))],
    summary="Confirm a suggested class for train images",
    description="""Moves the event's train images into the chosen dataset class and
    records which suggestion, if any, led to it beside the dataset.""",
)
async def confirm_suggestion(
    request: Request, name: str, body: ConfirmSuggestionBody
) -> JSONResponse:
    config: FrigateConfig = request.app.frigate_config
    if name not in config.classification.custom:
        return unknown_model(name)

    category = suggest.safe_category(body.category)
    if not category or suggest.normalize_class(category) in {"", "none"}:
        return JSONResponse(
            content={"success": False, "message": "Invalid category", "moved": []},
            status_code=400,
        )

    try:
        moved, _ = await asyncio.to_thread(confirm, name, body, category)
    except FileNotFoundError:
        return JSONResponse(
            content={
                "success": False,
                "message": "One of the train images no longer exists",
                "moved": [],
            },
            status_code=404,
        )
    except ValueError:
        return JSONResponse(
            content={"success": False, "message": "Invalid file name", "moved": []},
            status_code=400,
        )
    except OSError:
        logger.exception("Failed to move the train images of a suggestion")
        return JSONResponse(
            content={
                "success": False,
                "message": "Failed to move the train images",
                "moved": [],
            },
            status_code=500,
        )

    return JSONResponse(
        content={
            "success": True,
            "message": "Successfully categorized images.",
            "moved": moved,
        }
    )


@router.get(
    "/classification/{name}/suggestions/report",
    response_model=SuggestionReportResponse,
    dependencies=[Depends(require_role(["admin"]))],
    summary="Report how often suggested classes were kept",
    description=(
        "Reads the confirmations recorded beside the model's dataset and "
        "counts, overall and per source, suggested class and camera, how many "
        "drafts were filed unchanged (fork I42)."
    ),
)
async def suggestion_report(request: Request, name: str) -> JSONResponse:
    config: FrigateConfig = request.app.frigate_config
    if name not in config.classification.custom:
        return unknown_model(name)
    entries = await asyncio.to_thread(suggest.read_provenance, CLIPS_DIR, name)
    return JSONResponse(
        content={"model": name, **suggest.summarize_provenance(entries)}
    )
