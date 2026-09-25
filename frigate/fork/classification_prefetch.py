"""Fork (I43, I44, I45): draft a class as soon as a description arrives.

The train grid asks on demand, so the first time it opened a week of train
images could be waiting on one day's budget. This worker asks once per
description as it is written and stores the answer in the same cache the
grid reads, so the grid finds its answers already there and the daily limit
is spent evenly over the day. When auto-filing is on, a draft that text and
Jev agree on is filed here too, once people have kept that class often
enough (I44), and the trained model's own verdict for the event is compared
with the draft so a drifting model shows up in the report (I45). Auto-filing
also waits when the same camera filed the class recently (I48), skips images
the model already scores as the class (I49) or that are too small to train
on (I50), and never widens a class past the balance ratio (I51).
"""

import asyncio
import logging
import queue
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypedDict

import aiohttp

from frigate.config import FrigateConfig
from frigate.const import CLIPS_DIR
from frigate.fork import classification_suggestions as suggest
from frigate.models import Event

logger = logging.getLogger(__name__)

QUEUE_SIZE = 1000

AskFactory = Callable[[aiohttp.ClientSession], suggest.AskJev]


class DescriptionJob(TypedDict):
    id: str
    camera: str
    label: str
    description: str


class SuggestionPrefetch(threading.Thread):
    """A daemon thread that drafts a class for each queued description."""

    def __init__(
        self,
        config: FrigateConfig,
        clips_dir: str = CLIPS_DIR,
        ask_factory: AskFactory | None = None,
    ) -> None:
        super().__init__(name="fork_suggestion_prefetch", daemon=True)
        self.config = config
        self.clips_dir = clips_dir
        self.ask_factory = ask_factory
        self.queue: queue.Queue[DescriptionJob | None] = queue.Queue(maxsize=QUEUE_SIZE)
        self.cache, self.budget = suggest.open_state(Path(config.database.path).parent)

    def submit(self, job: DescriptionJob) -> bool:
        """Queue one description; False when the queue is full."""
        try:
            self.queue.put_nowait(job)
        except queue.Full:
            logger.warning("Suggestion prefetch queue is full, skipping one event")
            return False
        return True

    def stop(self) -> None:
        self.queue.put(None)

    def run(self) -> None:
        while (job := self.queue.get()) is not None:
            try:
                asyncio.run(self.process(job))
            except Exception:
                # Background task: one bad description must not stop the rest.
                logger.exception("Suggestion prefetch failed for one event")

    def models_for(self, label: str) -> dict[str, list[str]]:
        """Custom models that classify this label and already have classes."""
        result: dict[str, list[str]] = {}
        for name, model in self.config.classification.custom.items():
            objects = model.object_config
            if objects is None or label not in objects.objects:
                continue
            classes = suggest.dataset_classes(self.clips_dir, name)
            if suggest.candidate_classes(classes):
                result[name] = classes
        return result

    async def process(self, job: DescriptionJob) -> dict[str, suggest.EventSuggestion]:
        """Draft a class for the description under every model that applies."""
        models = self.models_for(job["label"])
        if not models:
            return {}
        settings = self.config.classification.suggestions
        jev_config = settings.jev
        jev: suggest.JevSettings = {
            "model": jev_config.model,
            "cameras": list(jev_config.cameras),
            "daily_request_limit": jev_config.daily_request_limit,
        }
        event = {
            "id": job["id"],
            "camera": job["camera"],
            "data": {"description": job["description"]},
        }
        results: dict[str, suggest.EventSuggestion] = {}
        async with aiohttp.ClientSession() as session:
            if self.ask_factory is not None:
                ask = self.ask_factory(session)
            else:
                ask = suggest.make_ask(
                    session, jev_config.url, suggest.api_key(), jev_config.timeout
                )
            for name, classes in models.items():
                drafts = await suggest.suggest_for_events(
                    [event],
                    classes,
                    settings.enabled,
                    jev,
                    self.cache,
                    self.budget,
                    ask,
                )
                results[name] = drafts[job["id"]]
        for name, draft in results.items():
            await asyncio.to_thread(self.auto_file, job, name, draft)
            await asyncio.to_thread(self.check_model, job, name, draft)
        return results

    def load_event(self, event_id: str) -> dict[str, Any] | None:
        """The event row's verdict fields, or None when it is gone."""
        row = (
            Event.select(Event.sub_label, Event.data)
            .where(Event.id == event_id)
            .dicts()
            .first()
        )
        return dict(row) if row else None

    def check_model(
        self, job: DescriptionJob, name: str, draft: suggest.EventSuggestion
    ) -> bool | None:
        """Record whether the trained model agreed with the draft (I45).

        Returns:
            True or False when both had an answer, None when nothing was recorded
        """
        suggestion = draft["suggestion"]
        model = self.config.classification.custom.get(name)
        if suggestion is None or model is None or model.object_config is None:
            return None
        event = self.load_event(job["id"])
        if event is None:
            return None
        classes = suggest.dataset_classes(self.clips_dir, name)
        said = suggest.model_verdict(
            name, model.object_config.classification_type.value, classes, event
        )
        if said is None:
            return None
        agree = suggest.normalize_class(said) == suggest.normalize_class(
            suggestion["category"]
        )
        suggest.record_model_check(
            self.clips_dir,
            name,
            {
                "event_id": job["id"],
                "camera": job["camera"],
                "model_said": said,
                "draft": suggestion["category"],
                "source": suggestion["source"],
                "score": suggestion["score"],
                "agree": agree,
                "description_sha256": suggest.description_sha256(job["description"]),
            },
        )
        return agree

    def worth_filing(
        self, event_id: str, name: str, category: str, max_score: float
    ) -> list[str]:
        """The event's train images that would teach the model something.

        Drops images the model already scores as the class (I49) and crops
        too small to train on (I50).
        """
        files = suggest.train_files_for_event(self.clips_dir, name, event_id)
        skip = set(suggest.sure_train_files(files, category, max_score))
        skip.update(suggest.too_small_train_files(self.clips_dir, name, files))
        return [file for file in files if file not in skip]

    def auto_file(
        self, job: DescriptionJob, name: str, draft: suggest.EventSuggestion
    ) -> list[str]:
        """File the event's train images when the draft has earned it (I44).

        Only a person's one-at-a-time confirmations earn it: auto-filed
        groups, bulk accepts and undone confirmations are left out of the
        kept rate and of min_drafts.

        Returns:
            The dataset file names written, empty when nothing was filed
        """
        settings = self.config.classification.suggestions.auto_file
        if not settings.enabled:
            return []
        sure = suggest.sure_draft(draft["text"], draft["jev"])
        if sure is None:
            return []
        entries = suggest.read_provenance(self.clips_dir, name)
        rate, reviewed = suggest.kept_rate(entries, sure["category"])
        if rate is None or rate < settings.min_kept_rate:
            return []
        if reviewed < settings.min_drafts:
            return []
        category = suggest.safe_category(sure["category"])
        if not category:
            return []
        wait = suggest.auto_file_wait(
            entries,
            category,
            job["camera"],
            time.time(),
            settings.camera_cooldown,
            settings.per_camera_daily_limit,
        )
        if wait is not None:
            logger.debug("Auto-filing %s/%s waits: %s", name, category, wait)
            return []
        files = self.worth_filing(job["id"], name, category, settings.max_model_score)
        if not files:
            return []
        counts = suggest.dataset_counts(self.clips_dir, name)
        if suggest.would_unbalance(counts, category, len(files)):
            logger.debug("Auto-filing %s/%s waits: class is lopsided", name, category)
            return []
        try:
            moved = suggest.file_train_images(
                self.clips_dir,
                name,
                category,
                files,
                {
                    "event_id": job["id"],
                    "camera": job["camera"],
                    "category": category,
                    "suggested_category": sure["category"],
                    "source": sure["source"],
                    "score": sure["score"],
                    "accepted": True,
                    "auto": True,
                    "description_sha256": suggest.description_sha256(
                        job["description"]
                    ),
                },
            )
        except suggest.AlreadyFiledError:
            # A person filed the group between the listing and the move.
            return []
        except (OSError, ValueError):
            logger.exception("Auto-filing the train images of one event failed")
            return []
        logger.info(
            "Auto-filed %d train image(s) into %s/%s", len(moved), name, category
        )
        return moved


_worker: SuggestionPrefetch | None = None
_lock = threading.Lock()


def prefetch_enabled(config: FrigateConfig) -> bool:
    """Whether descriptions should be drafted as they arrive."""
    settings = config.classification.suggestions
    return (
        settings.enabled
        and settings.jev.enabled
        and settings.jev.background
        and bool(config.classification.custom)
        and bool(suggest.api_key())
    )


def prefetch_for_event(config: FrigateConfig, event: Any) -> bool:
    """Queue the event's fresh description for a background draft.

    Args:
        config: The running config
        event: The saved Event row

    Returns:
        Whether the description was queued
    """
    if not prefetch_enabled(config):
        return False
    data = event.data if isinstance(event.data, dict) else {}
    description = data.get("description")
    description = description.strip() if isinstance(description, str) else ""
    if not description:
        return False
    global _worker
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = SuggestionPrefetch(config)
            _worker.start()
        worker = _worker
    return worker.submit(
        {
            "id": str(event.id),
            "camera": str(event.camera),
            "label": str(event.label),
            "description": description,
        }
    )
