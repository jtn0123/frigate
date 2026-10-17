"""Read effective API routes across FastAPI's flat and included route trees."""

from collections.abc import Iterator
from copy import copy

from fastapi import FastAPI
from fastapi.routing import APIRoute, APIWebSocketRoute


def api_routes(app: FastAPI) -> Iterator[APIRoute]:
    """Yield read-only route views with effective paths and dependencies.

    FastAPI 0.137+ keeps router inclusions as a tree. Its effective contexts
    contain include-time prefixes and dependencies that the original route
    definitions do not. Keep this pinned-version integration in one place;
    never change the original route while inspecting its inclusion context.
    """
    for route in app.routes:
        if isinstance(route, APIRoute):
            yield route
            continue
        if isinstance(route, APIWebSocketRoute):
            continue
        contexts = getattr(route, "effective_route_contexts", None)
        if not callable(contexts):
            if type(route).__module__.startswith("fastapi."):
                raise RuntimeError("Unsupported FastAPI route representation")
            continue
        for context in contexts():
            if not isinstance(context.original_route, APIRoute):
                continue
            effective = copy(context.original_route)
            for name in ("path", "path_format", "methods", "dependant", "endpoint"):
                setattr(effective, name, getattr(context, name))
            yield effective
