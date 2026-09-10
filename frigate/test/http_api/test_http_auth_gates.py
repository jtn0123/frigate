"""Every API route must declare exactly one auth gate."""

import unittest

from fastapi import APIRouter, Depends, FastAPI
from fastapi.routing import APIRoute

from frigate.api import app as main_app
from frigate.api import (
    auth,
    camera,
    chat,
    classification,
    debug_replay,
    event,
    export,
    media,
    motion_search,
    notification,
    preview,
    record,
    review,
)
from frigate.api.auth import (
    allow_any_authenticated,
    allow_public,
    assert_routes_have_auth_gate,
    require_camera_access,
    require_role,
    route_auth_gates,
)

ALL_ROUTERS = [
    auth.router,
    camera.router,
    chat.router,
    classification.router,
    review.router,
    main_app.router,
    preview.router,
    notification.router,
    export.router,
    event.router,
    media.router,
    motion_search.router,
    record.router,
    debug_replay.router,
]


def _app_with(*routers: APIRouter) -> FastAPI:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    return app


class TestRouteAuthGates(unittest.TestCase):
    def test_every_route_declares_exactly_one_gate(self):
        app = _app_with(*ALL_ROUTERS)
        routes = [r for r in app.routes if isinstance(r, APIRoute)]
        assert len(routes) > 100, "router set looks incomplete"

        missing = {
            f"{','.join(sorted(r.methods))} {r.path}": route_auth_gates(r)
            for r in routes
            if len(route_auth_gates(r)) != 1
        }
        assert missing == {}, missing

        # and the startup assertion agrees
        assert_routes_have_auth_gate(app)

    def test_each_marker_kind_is_recognised(self):
        router = APIRouter()

        @router.get("/public", dependencies=[Depends(allow_public())])
        def public():
            return {}

        @router.get("/any", dependencies=[Depends(allow_any_authenticated())])
        def any_user():
            return {}

        @router.get("/admin", dependencies=[Depends(require_role(["admin"]))])
        def admin():
            return {}

        @router.get("/{camera_name}", dependencies=[Depends(require_camera_access)])
        def cam(camera_name: str):
            return {}

        app = _app_with(router)
        gates = {
            r.path: route_auth_gates(r) for r in app.routes if isinstance(r, APIRoute)
        }
        assert gates == {
            "/public": ["public_checker"],
            "/any": ["auth_checker"],
            "/admin": ["role_checker"],
            "/{camera_name}": ["require_camera_access"],
        }
        assert_routes_have_auth_gate(app)

    def test_missing_gate_fails_startup(self):
        router = APIRouter()

        @router.get("/ungated")
        def ungated():
            return {}

        with self.assertRaises(RuntimeError) as ctx:
            assert_routes_have_auth_gate(_app_with(router))
        assert "GET /ungated" in str(ctx.exception)

    def test_duplicate_gates_fail_startup(self):
        router = APIRouter()

        @router.get(
            "/double",
            dependencies=[
                Depends(allow_public()),
                Depends(require_role(["admin"])),
            ],
        )
        def double():
            return {}

        with self.assertRaises(RuntimeError):
            assert_routes_have_auth_gate(_app_with(router))
