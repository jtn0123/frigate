"""Fork (I41): settings for drafting dataset classes from descriptions."""

from pydantic import Field

from frigate.config.base import FrigateBaseModel


class JevSuggestionsConfig(FrigateBaseModel):
    enabled: bool = Field(
        default=False,
        title="Ask Jev",
        description="Send the description text of train images to Jev through OpenRouter for a class suggestion. Needs FRIGATE_JEV_API_KEY or OPENROUTER_API_KEY in the environment. Only the text is sent: no images, camera names, ids or timestamps.",
    )
    model: str = Field(
        default="typesafe/jev-1.13",
        title="Jev model",
        description="The OpenRouter Decisions model to ask.",
    )
    url: str = Field(
        default="https://openrouter.ai/api/alpha/decisions",
        title="Decisions URL",
        description="Where Decisions requests are posted. Change it to route through a gateway.",
    )
    daily_request_limit: int = Field(
        default=200,
        ge=1,
        le=10000,
        title="Daily request limit",
        description="Maximum provider requests per UTC day, counted across restarts. Answers are cached, so a description is only ever sent once.",
    )
    cameras: list[str] = Field(
        default_factory=list,
        title="Cameras",
        description="Only send descriptions from these cameras. Empty means every camera.",
    )
    timeout: int = Field(
        default=20,
        ge=1,
        le=120,
        title="Request timeout",
        description="Seconds to wait for one Jev answer.",
    )


class ClassificationSuggestionsConfig(FrigateBaseModel):
    enabled: bool = Field(
        default=True,
        title="Suggest classes from descriptions",
        description="Show a suggested class on the train grid of custom classification models, read locally from each event's description. Nothing leaves Frigate unless Jev is enabled.",
    )
    jev: JevSuggestionsConfig = Field(
        default_factory=JevSuggestionsConfig,
        title="Jev",
        description="Optional Jev text extraction through OpenRouter.",
    )
