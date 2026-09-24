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
