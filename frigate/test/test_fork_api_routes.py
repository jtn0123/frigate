"""Introspection preserves included paths and effective authorization gates."""

import importlib
import unittest

from fastapi import APIRouter, Depends, FastAPI, WebSocket

from frigate.api.auth import (
    allow_public,
    assert_routes_have_auth_gate,
    require_role,
    route_auth_gates,
)
from frigate.fork.api_routes import api_routes


class TestEffectiveApiRoutes(unittest.TestCase):
    def test_direct_http_routes_are_kept_and_websockets_are_excluded(self):
        app = FastAPI()

        @app.get("/health", dependencies=[Depends(allow_public())])
        def health():
            return {}

        @app.websocket("/updates")
        async def updates(websocket: WebSocket):
            await websocket.close()

        self.assertEqual([r.path for r in api_routes(app)], ["/health"])
        assert_routes_have_auth_gate(app)

    def test_nested_prefixes_and_include_dependencies_are_preserved(self):
        child = APIRouter()

        @child.get("/files/{filename:path}")
        def files(filename: str):
            return filename

        parent = APIRouter()
        parent.include_router(child, prefix="/nested")
        app = FastAPI()
        app.include_router(
            parent, prefix="/api", dependencies=[Depends(require_role(["admin"]))]
        )
        routes = list(api_routes(app))
        self.assertEqual(len(routes), 1)
        route = routes[0]
        self.assertEqual(route.path, "/api/nested/files/{filename:path}")
        self.assertEqual(route.path_format, "/api/nested/files/{filename}")
        self.assertEqual(route_auth_gates(route), ["role_checker"])
        assert_routes_have_auth_gate(app)
        self.assertEqual(child.routes[0].path, "/files/{filename:path}")
        self.assertEqual(route_auth_gates(child.routes[0]), [])

    def test_duplicate_include_and_route_gates_fail_closed(self):
        router = APIRouter()

        @router.get("/public", dependencies=[Depends(allow_public())])
        def public():
            return {}

        app = FastAPI()
        app.include_router(
            router, prefix="/nested", dependencies=[Depends(require_role(["admin"]))]
        )
        with self.assertRaisesRegex(RuntimeError, "GET /nested/public"):
            assert_routes_have_auth_gate(app)

    def test_generator_annotates_every_openapi_operation(self):
        generator = importlib.import_module("generate_api_auth_spec")

        app = generator.build_app()
        paths, prefixes = generator.read_exempt_rules()
        access = generator.build_access_map(app, paths, prefixes)
        spec = generator.base_document(app.openapi())
        _, _, unmatched = generator.enrich(spec, access)
        self.assertGreater(len(access), 100)
        self.assertEqual(unmatched, [])
        self.assertEqual(generator.validate(spec), [])
