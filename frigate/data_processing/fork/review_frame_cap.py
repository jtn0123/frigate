"""Bound review image work while retaining the available sequence endpoints."""

from typing import TypeVar

Frame = TypeVar("Frame")


def limit_review_frames(frames: list[Frame], max_frames: int | None) -> list[Frame]:
    """Select uniformly spaced frame references without padding or mutation.

    The configured limit is at least two so both available endpoints survive.
    Sampling follows the existing preview sampler's uniform index spacing;
    recording extraction already spaces its timestamps uniformly.
    """
    if max_frames is None:
        return frames
    if max_frames < 2:
        raise ValueError("Review frame limit must preserve both endpoints")
    if len(frames) <= max_frames:
        return frames

    step = (len(frames) - 1) / (max_frames - 1)
    return [frames[round(index * step)] for index in range(max_frames)]
