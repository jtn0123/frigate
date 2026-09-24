"""Fork (I41): request bodies for classification suggestions."""

from pydantic import BaseModel, Field


class ConfirmSuggestionBody(BaseModel):
    event_id: str = Field(description="The event the train images belong to")
    category: str = Field(description="The dataset class to file the images under")
    training_files: list[str] = Field(
        min_length=1,
        max_length=64,
        description="Train file names to move into the class",
    )
    source: str | None = Field(
        default=None,
        description="Which source suggested the class: text, jev, or none if edited",
    )
    score: float | None = Field(
        default=None, ge=0, le=1, description="The suggestion's score, if any"
    )
    suggested_category: str | None = Field(
        default=None,
        description="The class that was suggested, so edits can be told apart",
    )
