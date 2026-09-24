"""Fork (I41): response models for classification suggestions."""

from pydantic import BaseModel, Field


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

    model: str = Field(description="The classification model")
    classes: list[str] = Field(description="Dataset classes a draft can name")
    jev: JevStateModel
    suggestions: dict[str, EventSuggestionModel] = Field(
        description="Keyed by event id; ids without an event are omitted"
    )


class ConfirmSuggestionResponse(BaseModel):
    """What the confirmation moved."""

    success: bool
    message: str
    moved: list[str] = Field(default_factory=list, description="New dataset file names")


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


class SuggestionReportResponse(AcceptanceModel):
    """Acceptance of the drafts recorded for one model (fork I42)."""

    model: str = Field(description="The classification model")
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
