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
    background: bool = Field(
        default=True,
        title="Ask as descriptions arrive",
        description="Ask Jev for a class as soon as each description is written, so the train grid finds the answer already cached and the daily limit is spread over the day. Off means Jev is only asked while the train grid is open.",
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


class AutoFileSuggestionsConfig(FrigateBaseModel):
    enabled: bool = Field(
        default=False,
        title="Auto-file sure drafts",
        description="File a train image into its dataset class without review when the local text match and Jev name the same class and people have kept that class's drafts often enough. Auto-filed images never count toward that rate.",
    )
    min_kept_rate: float = Field(
        default=0.9,
        ge=0.5,
        le=1.0,
        title="Minimum kept rate",
        description="The share of a class's drafts people filed unchanged before it may be auto-filed.",
    )
    min_drafts: int = Field(
        default=20,
        ge=1,
        le=10000,
        title="Minimum reviewed drafts",
        description="How many drafts of a class people must have reviewed before it may be auto-filed.",
    )
    camera_cooldown: int = Field(
        default=7200,
        ge=0,
        le=604800,
        title="Same camera cooldown",
        description="Seconds to wait before auto-filing the same class from the same camera again, so a regular visitor or a parked car does not fill a class with near-identical images (I48).",
    )
    per_camera_daily_limit: int = Field(
        default=10,
        ge=1,
        le=1000,
        title="Per camera daily limit",
        description="Most groups of one class auto-filed from one camera per day (I48).",
    )
    max_model_score: float = Field(
        default=0.9,
        ge=0.5,
        le=1.0,
        title="Skip sure images",
        description="Skip train images the trained model already scored at or above this as the drafted class. They teach it nothing new (I49). Images under 100 pixels on a side are always skipped (I50), and a class is never auto-filed past three times the smallest class (I51).",
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
    auto_file: AutoFileSuggestionsConfig = Field(
        default_factory=AutoFileSuggestionsConfig,
        title="Auto-file",
        description="File drafts that text and Jev agree on, once a class has earned it.",
    )
