from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

NonEmptyId = Annotated[str, StringConstraints(min_length=1)]


class ReviewModifyMultipleBody(BaseModel):
    # List of string with at least one element and each element with at least one char
    ids: list[NonEmptyId] = Field(min_length=1)
    # Whether to mark items as reviewed (True) or unreviewed (False)
    reviewed: bool = True
