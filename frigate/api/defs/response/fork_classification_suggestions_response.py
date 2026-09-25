"""Fork (I41): response models for classification suggestions."""

from pydantic import BaseModel, Field

MODEL_DESCRIPTION = "The classification model"


class SuggestionModel(BaseModel):
    """One draft class and where it came from."""

    category: str = Field(description="Dataset class the description supports")
    source: str = Field(description="text (local match) or jev")
    score: float | None = Field(
        default=None, description="Jev probability of the category, if from Jev"
    )
    evidence: str = Field(
        default="", description="The sentence of the description that matched"
    )


class EventSuggestionModel(BaseModel):
    """Both sources for one event and the draft the grid should show."""

    text: SuggestionModel | None = Field(
        default=None, description="Local text match, if any"
    )
    jev: SuggestionModel | None = Field(default=None, description="Jev draft, if any")
    jev_status: str = Field(
        description=(
            "answered, unknown, disabled, no_description, no_classes, "
            "camera_not_allowed, budget or error"
        )
    )
    suggestion: SuggestionModel | None = Field(
        default=None, description="The draft to show, or none when unsure"
    )
    conflict: bool = Field(description="The two sources named different classes")


class JevStateModel(BaseModel):
    """Whether Jev can be asked right now."""

    enabled: bool = Field(description="classification.suggestions.jev.enabled")
    configured: bool = Field(description="An API key is present in the environment")
    used_today: int = Field(description="Provider requests counted today", ge=0)
    daily_request_limit: int = Field(description="The configured daily cap", ge=0)


class ClassificationSuggestionsResponse(BaseModel):
    """Suggestions for the requested events of one model."""

    model: str = Field(description=MODEL_DESCRIPTION)
    classes: list[str] = Field(description="Dataset classes a draft can name")
    jev: JevStateModel
    suggestions: dict[str, EventSuggestionModel] = Field(
        description="Keyed by event id; ids without an event are omitted"
    )
    too_small: dict[str, list[str]] = Field(
        default_factory=dict,
        description="Train images under 100 px on a side, keyed by event (fork I50)",
    )
    omitted: int = Field(
        default=0,
        ge=0,
        description="Distinct ids past the per-request cap that were not drafted",
    )


class ConfirmSuggestionResponse(BaseModel):
    """What the confirmation moved."""

    success: bool
    message: str
    moved: list[str] = Field(default_factory=list, description="New dataset file names")


class UndoSuggestionResponse(BaseModel):
    """How many images an undo moved back to the train grid."""

    success: bool
    message: str
    restored: int = Field(default=0, ge=0, description="Images moved back")


class FiledModel(BaseModel):
    """What an event's train images were filed as (fork I46)."""

    category: str = Field(description="The dataset class")
    auto: bool = Field(description="Filed by I44 without review")


class EventModelSuggestionModel(BaseModel):
    """One custom model's view of one event (fork I46)."""

    model: str = Field(description=MODEL_DESCRIPTION)
    classes: list[str] = Field(description="Dataset classes a draft can name")
    suggestion: EventSuggestionModel
    training_files: list[str] = Field(
        default_factory=list, description="Train images still waiting for the event"
    )
    model_said: str | None = Field(
        default=None, description="The trained model's class for the event"
    )
    filed: FiledModel | None = Field(
        default=None, description="What the event was last filed as, if anything"
    )
    too_small: list[str] = Field(
        default_factory=list,
        description="Train images under 100 px on a side (fork I50)",
    )


class EventSuggestionsResponse(BaseModel):
    """Drafts for one event under every model that applies (fork I46)."""

    event_id: str = Field(description="The event")
    models: list[EventModelSuggestionModel] = Field(default_factory=list)


class AcceptanceModel(BaseModel):
    """How many drafts were filed unchanged (fork I42)."""

    total: int = Field(description="Confirmations recorded", ge=0)
    accepted: int = Field(description="Drafts filed under the suggested class", ge=0)
    rate: float | None = Field(
        default=None, description="accepted / total, or none without data"
    )


class ClassAcceptanceModel(AcceptanceModel):
    """Acceptance of one suggested class and what it was corrected to."""

    corrected_to: dict[str, int] = Field(
        default_factory=dict, description="Class chosen instead, with counts"
    )
    auto_filed: int = Field(
        default=0, description="Groups I44 filed without review, not in the rate", ge=0
    )
    bulk_accepted: int = Field(
        default=0, description="Groups filed by Accept all, not in the rate", ge=0
    )


class DisagreementModel(BaseModel):
    """One event where the trained model and the description disagreed."""

    time: float | None = Field(default=None, description="Unix time of the check")
    event_id: str | None = Field(default=None, description="The event")
    camera: str | None = Field(default=None, description="The camera")
    model_said: str = Field(description="The trained model's class")
    draft: str = Field(description="The class the description supported")


class ModelCheckModel(AcceptanceModel):
    """How often the trained model agreed with the description (fork I45).

    ``accepted`` counts agreements here.
    """

    total: int = Field(default=0, description="Events checked", ge=0)
    accepted: int = Field(default=0, description="Events where both agreed", ge=0)
    classes: dict[str, ClassAcceptanceModel] = Field(
        default_factory=dict,
        description="Keyed by the model's class; corrected_to is what the description said instead",
    )
    recent_disagreements: list[DisagreementModel] = Field(
        default_factory=list, description="Latest disagreements, newest first"
    )


class DatasetBalanceModel(BaseModel):
    """Whether one class dwarfs another (fork I51)."""

    classes: dict[str, int] = Field(
        default_factory=dict, description="Images per dataset class"
    )
    empty: list[str] = Field(default_factory=list, description="Classes with no images")
    largest: str | None = Field(default=None, description="The fullest class")
    smallest: str | None = Field(default=None, description="The emptiest filled class")
    ratio: float | None = Field(default=None, description="largest / smallest")
    lopsided: bool = Field(default=False, description="ratio is over 3")


class TrainingGapModel(BaseModel):
    """Images added since the model was last trained (fork I54)."""

    has_trained: bool = Field(default=False)
    last_training_date: str | None = Field(default=None)
    current_images: int = Field(default=0, ge=0)
    new_images: int = Field(default=0, ge=0)


class AutoFiledGroupModel(BaseModel):
    """One event's images filed without review, for a spot check (fork I52)."""

    time: float | None = Field(default=None, description="Unix time it was filed")
    event_id: str | None = Field(default=None)
    camera: str | None = Field(default=None)
    category: str = Field(description="The dataset class")
    source: str | None = Field(default=None, description="text or jev")
    score: float | None = Field(default=None)
    files: list[str] = Field(default_factory=list, description="Dataset file names")


class SpotCheckResponse(BaseModel):
    """What a spot check removed (fork I52)."""

    success: bool
    message: str
    removed: list[str] = Field(
        default_factory=list, description="Dataset files deleted"
    )


class SuggestionReportResponse(AcceptanceModel):
    """Acceptance of the drafts recorded for one model (fork I42)."""

    model: str = Field(description=MODEL_DESCRIPTION)
    auto_filed: int = Field(
        default=0, description="Groups I44 filed without review, not in the rate", ge=0
    )
    bulk_accepted: int = Field(
        default=0, description="Groups filed by Accept all, not in the rate", ge=0
    )
    undone: int = Field(
        default=0, description="Confirmations later undone, not in any count", ge=0
    )
    sources: dict[str, AcceptanceModel] = Field(
        default_factory=dict, description="Keyed by source: text, jev or none"
    )
    classes: dict[str, ClassAcceptanceModel] = Field(
        default_factory=dict, description="Keyed by the suggested class"
    )
    cameras: dict[str, AcceptanceModel] = Field(
        default_factory=dict, description="Keyed by camera"
    )
    first_time: float | None = Field(
        default=None, description="Unix time of the earliest confirmation"
    )
    last_time: float | None = Field(
        default=None, description="Unix time of the latest confirmation"
    )
    model_check: ModelCheckModel = Field(
        default_factory=ModelCheckModel,
        description="The trained model's verdicts against the drafts (fork I45)",
    )
    dataset: DatasetBalanceModel = Field(
        default_factory=DatasetBalanceModel,
        description="Images per class and whether they are lopsided (fork I51)",
    )
    training: TrainingGapModel = Field(
        default_factory=TrainingGapModel,
        description="Images added since the last training (fork I54)",
    )
    recent_auto_filed: list[AutoFiledGroupModel] = Field(
        default_factory=list,
        description="Auto-filed groups awaiting a spot check, newest first (fork I52)",
    )
