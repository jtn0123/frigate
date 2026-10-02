"""Coverage for the chat tool calling and VLM monitor APIs (fork D73)."""

import asyncio
import json
import threading
import time
from datetime import datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from frigate.api import chat as chat_api
from frigate.config.classification import SemanticSearchModelEnum
from frigate.embeddings.util import ZScoreNormalization
from frigate.models import Event, Export, ExportCase, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

BASE = datetime(2026, 9, 1, 12, 0, 0)
BASE_TS = time.mktime(BASE.timetuple())


def _run(coro):
    return asyncio.run(coro)


def _stats(values: list[float]) -> ZScoreNormalization:
    stats = ZScoreNormalization()
    stats._update(values)
    return stats


def _embeddings(visual=None, description=None) -> MagicMock:
    context = MagicMock()
    context.search_thumbnail.return_value = visual or []
    context.search_description.return_value = description or []
    context.thumb_stats = _stats([0.1, 0.2, 0.3, 0.4, 0.5])
    context.desc_stats = _stats([0.1, 0.2, 0.3, 0.4, 0.5])
    return context


class ScriptedClient:
    """Non-streaming chat client that replays canned responses."""

    def __init__(self, *responses: dict[str, Any], supports_vision: bool = False):
        self.responses = list(responses)
        self.calls: list[list[dict[str, Any]]] = []
        self.supports_vision = supports_vision

    def chat_with_tools(self, **kwargs):
        self.calls.append(json.loads(json.dumps(kwargs["messages"])))
        return self.responses.pop(0)


class _ChatHttpTestCase(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Export, ExportCase])
        self.minimal_config["semantic_search"] = {"enabled": True}
        self.minimal_config["cameras"]["front_door"]["zones"] = {
            "front_yard": {
                "coordinates": "0,0,100,0,100,100,0,100",
                "friendly_name": "Front Walkway",
            }
        }
        self.minimal_config["cameras"]["back_yard"] = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
        }
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def request(self, role: str = "admin", user: str = "admin") -> SimpleNamespace:
        return SimpleNamespace(
            app=self.app, headers={"remote-role": role, "remote-user": user}
        )

    def add_event(
        self,
        event_id: str,
        label: str = "person",
        camera: str = "front_door",
        sub_label: str | None = None,
        zones: list[str] | None = None,
        start: float = BASE_TS,
        data: dict | None = None,
    ) -> None:
        Event.insert(
            id=event_id,
            label=label,
            sub_label=sub_label,
            camera=camera,
            start_time=start,
            end_time=start + 10,
            top_score=0.9,
            score=0.9,
            false_positive=False,
            zones=zones or [],
            thumbnail="",
            has_clip=True,
            has_snapshot=True,
            region=[],
            box=[],
            area=0,
            data=data or {},
        ).execute()


class TestGetTools(_ChatHttpTestCase):
    def test_tools_endpoint_lists_definitions(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/chat/tools")

        assert response.status_code == 200
        names = {tool["function"]["name"] for tool in response.json()["tools"]}
        assert {"search_objects", "find_similar_objects", "get_recap"} <= names

    def test_embeddings_language(self):
        english = SimpleNamespace(
            semantic_search=SimpleNamespace(model=SemanticSearchModelEnum.jinav1)
        )
        multi = SimpleNamespace(
            semantic_search=SimpleNamespace(model=SemanticSearchModelEnum.jinav2)
        )
        assert chat_api._embeddings_language(english) == "english"
        assert chat_api._embeddings_language(multi) == "multi"


class TestResolveZones(_ChatHttpTestCase):
    def test_maps_case_and_friendly_names_to_config_keys(self):
        config = self.app.frigate_config
        resolved = chat_api._resolve_zones(
            ["FRONT_YARD", "front walkway", "Front Yard"],
            config,
            ["missing_camera", "front_door"],
        )
        # Only the key or friendly name match (case-insensitively); a spaced
        # variant of the key is not normalized and passes through.
        assert resolved == ["front_yard", "front_yard", "Front Yard"]

    def test_empty_zones_pass_through(self):
        assert (
            chat_api._resolve_zones([], self.app.frigate_config, ["front_door"]) == []
        )


class TestSearchObjectsStructured(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        self.app.frigate_config.semantic_search.enabled = False

    def test_execute_endpoint_returns_matching_events(self):
        self.add_event("a1", label="car")
        self.add_event("a2", label="person", camera="back_yard")
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/chat/execute",
                json={
                    "tool_name": "search_objects",
                    "arguments": {"camera": "front_door", "label": "car"},
                },
            )

        assert response.status_code == 200
        assert [event["id"] for event in response.json()] == ["a1"]

    def test_arguments_are_mapped_to_events_query(self):
        captured = {}

        def fake_events(params, allowed):
            captured["params"] = params
            captured["allowed"] = allowed
            return JSONResponse(content=[])

        with patch.object(chat_api, "events", side_effect=fake_events):
            _run(
                chat_api._execute_search_objects(
                    self.request(),
                    {
                        "after": "2026-09-01T11:00:00Z",
                        "before": "2026-09-01T13:00:00",
                        "zones": ["Front Walkway"],
                        "attribute": "amazon",
                        "semantic_query": "   ",
                        "limit": 3,
                    },
                    ["front_door", "back_yard"],
                )
            )

        params = captured["params"]
        assert params.after == time.mktime(datetime(2026, 9, 1, 11).timetuple())
        assert params.before == time.mktime(datetime(2026, 9, 1, 13).timetuple())
        assert params.zones == "front_yard"
        assert params.attributes == "amazon"
        assert params.limit == 3
        assert captured["allowed"] == ["front_door", "back_yard"]

    def test_invalid_timestamps_are_dropped_and_zones_default_to_all(self):
        captured = {}

        def fake_events(params, allowed):
            captured["params"] = params
            return JSONResponse(content=[])

        with patch.object(chat_api, "events", side_effect=fake_events):
            _run(
                chat_api._execute_search_objects(
                    self.request(),
                    {"after": "yesterday", "before": 12, "camera": "back_yard"},
                    ["front_door"],
                )
            )

        params = captured["params"]
        assert params.after is None
        assert params.before is None
        assert params.zones == "all"
        assert params.attributes == "all"
        assert params.cameras == "back_yard"

    def test_zone_list_resolves_against_the_named_camera(self):
        captured = {}

        def fake_events(params, allowed):
            captured["params"] = params
            return JSONResponse(content=[])

        with patch.object(chat_api, "events", side_effect=fake_events):
            _run(
                chat_api._execute_search_objects(
                    self.request(),
                    {"camera": "back_yard", "zones": ["Front Yard", "driveway"]},
                    ["front_door", "back_yard"],
                )
            )

        # back_yard has no zones, so names pass through untouched.
        assert captured["params"].zones == "Front Yard,driveway"

    def test_events_failure_returns_500(self):
        with patch.object(chat_api, "events", side_effect=RuntimeError("db gone")):
            response = _run(
                chat_api._execute_search_objects(self.request(), {}, ["front_door"])
            )

        assert response.status_code == 500
        assert json.loads(response.body)["message"] == "Error searching objects"


class TestSearchObjectsSemantic(_ChatHttpTestCase):
    def search(self, arguments: dict, allowed: list[str] | None = None) -> Any:
        response = _run(
            chat_api._execute_search_objects(
                self.request(),
                {"semantic_query": "red truck", **arguments},
                ["front_door", "back_yard"] if allowed is None else allowed,
            )
        )
        return json.loads(response.body)

    def test_missing_embeddings_returns_empty(self):
        self.app.embeddings = None
        assert self.search({}) == []

    def test_camera_outside_allowed_list_returns_empty(self):
        self.app.embeddings = _embeddings(visual=[("a", 0.1)])
        assert self.search({"camera": "garage"}) == []
        assert self.search({}, allowed=[]) == []
        self.app.embeddings.search_thumbnail.assert_not_called()

    def test_no_vector_hits_returns_empty(self):
        self.app.embeddings = _embeddings()
        assert self.search({"camera": "all"}) == []

    def test_search_failures_are_tolerated(self):
        context = _embeddings()
        context.search_thumbnail.side_effect = RuntimeError("thumb")
        context.search_description.side_effect = RuntimeError("desc")
        self.app.embeddings = context
        assert self.search({}) == []

    def test_results_are_filtered_fused_and_ranked(self):
        self.add_event(
            "best",
            label="car",
            sub_label="Mail",
            zones=["front_yard"],
            data={"attrs": {"x": "amazon"}},
        )
        self.add_event(
            "second",
            label="car",
            sub_label="mail",
            zones=["front_yard"],
            data={"attrs": {"x": "amazon"}},
        )
        self.add_event("wrong_label", label="person", zones=["front_yard"])
        self.add_event("too_old", label="car", start=BASE_TS - 7200)
        self.add_event("other_cam", label="car", camera="back_yard")
        self.app.embeddings = _embeddings(
            visual=[("best", 0.1), ("second", 0.4), ("wrong_label", 0.1)],
            description=[("best", 0.1), ("too_old", 0.1), ("other_cam", 0.1)],
        )

        results = self.search(
            {
                "camera": "front_door",
                "label": "car",
                "sub_label": "MAIL",
                "attribute": "amazon",
                "zones": ["Front Walkway"],
                "after": "2026-09-01T11:30:00",
                "before": "2026-09-01T12:30:00",
                "limit": 500,
            }
        )

        assert [r["id"] for r in results] == ["best", "second"]
        assert results[0]["score"] > results[1]["score"]

    def test_limit_is_clamped(self):
        for index in range(3):
            self.add_event(f"e{index}")
        self.app.embeddings = _embeddings(
            visual=[("e0", 0.1), ("e1", 0.2), ("e2", 0.3)]
        )
        results = self.search({"limit": 0})
        assert [r["id"] for r in results] == ["e0"]


class TestFindSimilarObjectsExtra(_ChatHttpTestCase):
    def find(self, arguments: dict) -> dict:
        return _run(
            chat_api._execute_find_similar_objects(
                self.request(), arguments, ["front_door", "back_yard"]
            )
        )

    def test_missing_embeddings_and_event_id(self):
        self.app.embeddings = None
        assert self.find({"event_id": "x"})["message"] == (
            "Embeddings context is not available."
        )
        self.app.embeddings = _embeddings()
        assert self.find({})["error"] == "missing_event_id"

    def test_similarity_search_failure(self):
        self.add_event("anchor")
        context = _embeddings()
        context.search_thumbnail.side_effect = RuntimeError("vec")
        self.app.embeddings = context
        result = self.find({"event_id": "anchor"})
        assert result["error"] == "similarity_search_failed"

    def test_structured_filters_restrict_candidates(self):
        self.add_event("anchor", label="car")
        self.add_event("match", label="car", sub_label="Mail", zones=["front_yard"])
        self.add_event("no_zone", label="car", sub_label="Mail")
        self.add_event(
            "hidden_cam",
            label="car",
            sub_label="Mail",
            camera="back_yard",
            zones=["front_yard"],
        )
        self.add_event("late", label="car", sub_label="Mail", start=BASE_TS + 7200)
        self.app.embeddings = _embeddings(
            visual=[
                ("anchor", 0.0),
                ("match", 0.1),
                ("no_zone", 0.1),
                ("hidden_cam", 0.1),
                ("late", 0.1),
            ]
        )

        result = self.find(
            {
                "event_id": "anchor",
                "cameras": ["front_door", "garage"],
                "sub_labels": ["Mail"],
                "zones": ["FRONT_YARD"],
                "after": "2026-09-01T11:00:00",
                "before": "2026-09-01T13:00:00",
                "similarity_mode": "nonsense",
            }
        )

        assert result["similarity_mode"] == "fused"
        assert result["anchor"]["id"] == "anchor"
        assert [r["id"] for r in result["results"]] == ["match"]
        assert result["candidate_truncated"] is False

    def test_execute_endpoint_reports_errors_with_400(self):
        self.app.frigate_config.semantic_search.enabled = False
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/chat/execute",
                json={
                    "tool_name": "find_similar_objects",
                    "arguments": {"event_id": "x"},
                },
            )
        assert response.status_code == 400
        assert response.json()["error"] == "semantic_search_disabled"

    def test_execute_endpoint_returns_results_with_200(self):
        self.add_event("anchor")
        self.app.embeddings = _embeddings()
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/chat/execute",
                json={
                    "tool_name": "find_similar_objects",
                    "arguments": {"event_id": "anchor"},
                },
            )
        assert response.status_code == 200
        assert response.json()["results"] == []


class TestExecuteEndpointMisc(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        self.dispatcher = MagicMock()
        self.dispatcher._camera_settings_handlers = {"detect": MagicMock()}
        self.app.dispatcher = self.dispatcher

    def test_set_camera_state_success_and_failure(self):
        with AuthTestClient(self.app) as client:
            ok = client.post(
                "/chat/execute",
                json={
                    "tool_name": "set_camera_state",
                    "arguments": {
                        "camera": "front_door",
                        "feature": "detect",
                        "value": "OFF",
                    },
                },
            )
            bad = client.post(
                "/chat/execute",
                json={
                    "tool_name": "set_camera_state",
                    "arguments": {"camera": "front_door", "feature": "nope"},
                },
            )

        assert ok.status_code == 200
        assert ok.json()["success"] is True
        self.dispatcher._receive.assert_called_once_with("front_door/detect/set", "OFF")
        assert bad.status_code == 400

    def test_unknown_tool(self):
        with AuthTestClient(self.app) as client:
            response = client.post(
                "/chat/execute", json={"tool_name": "launch_rocket", "arguments": {}}
            )
        assert response.status_code == 400
        assert response.json()["tool"] == "launch_rocket"


class TestSetCameraState(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        self.dispatcher = MagicMock()
        self.dispatcher._camera_settings_handlers = {"detect": MagicMock()}
        self.app.dispatcher = self.dispatcher

    def set_state(self, **arguments) -> dict:
        return _run(chat_api._execute_set_camera_state(self.request(), arguments))

    def test_requires_all_fields(self):
        result = self.set_state(camera="front_door", feature="detect")
        assert result == {"error": "camera, feature, and value are all required."}

    def test_profile_requires_wildcard_camera(self):
        result = self.set_state(camera="front_door", feature="profile", value="away")
        assert result["error"] == "Profile feature requires camera='*'."
        result = self.set_state(camera="*", feature="profile", value="away")
        assert result["success"] is True
        self.dispatcher._receive.assert_called_once_with("profile/set", "away")

    def test_unknown_feature_and_camera(self):
        assert self.set_state(camera="front_door", feature="x", value="ON") == {
            "error": "Unknown feature: x"
        }
        assert self.set_state(camera="garage", feature="detect", value="ON") == {
            "error": "Camera 'garage' not found."
        }
        self.dispatcher._receive.assert_not_called()

    def test_wildcard_applies_to_every_camera(self):
        result = self.set_state(camera="*", feature="detect", value="ON")
        assert result["success"] is True
        topics = [c.args[0] for c in self.dispatcher._receive.call_args_list]
        assert topics == ["front_door/detect/set", "back_yard/detect/set"]


class TestLiveContext(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        person = SimpleNamespace(
            to_dict=lambda: {
                "frame_time": 10.0,
                "label": "person",
                "current_zones": ["front_yard"],
                "sub_label": "Alice",
                "stationary": True,
            }
        )
        stale = SimpleNamespace(to_dict=lambda: {"frame_time": 9.0, "label": "car"})
        self.state = SimpleNamespace(
            current_frame_lock=threading.Lock(),
            tracked_objects={"p1": person, "c1": stale},
            current_frame_time=10.0,
        )
        self.processor = MagicMock()
        self.processor.get_camera_state.return_value = self.state
        self.processor.get_current_frame.return_value = np.zeros(
            (20, 20, 3), dtype=np.uint8
        )
        self.app.detected_frames_processor = self.processor

    def live(self, camera: str, allowed: list[str] | None = None) -> dict:
        return _run(
            chat_api._execute_get_live_context(
                self.request(), camera, allowed or ["front_door", "garage"]
            )
        )

    def test_rejects_wildcards_and_unknown_cameras(self):
        assert "wildcards" in self.live("*")["error"]
        assert self.live("back_yard")["error"] == (
            "Camera 'back_yard' not found or access denied"
        )
        assert self.live("garage") == {"error": "Camera 'garage' not found"}

    def test_detections_and_image_for_vision_model(self):
        self.app.genai_manager = SimpleNamespace(
            chat_client=SimpleNamespace(supports_vision=True)
        )
        result = self.live("front_door")
        assert result["camera"] == "front_door"
        assert result["timestamp"] == 10.0
        assert result["detections"] == [
            {
                "label": "person",
                "zones": ["front_yard"],
                "sub_label": "Alice",
                "stationary": True,
            }
        ]
        assert result["_image_url"].startswith("data:image/jpeg;base64,")

    def test_no_image_without_vision(self):
        self.app.genai_manager = SimpleNamespace(
            chat_client=SimpleNamespace(supports_vision=False)
        )
        assert "_image_url" not in self.live("front_door")

    def test_processor_failure_returns_error(self):
        self.processor.get_camera_state.side_effect = RuntimeError("boom")
        assert self.live("front_door") == {"error": "Error getting live context"}

    def test_frame_url_requires_allowed_camera(self):
        url = _run(
            chat_api._get_live_frame_image_url(self.request(), "front_door", ["x"])
        )
        assert url is None


class TestToolDispatchInternal(_ChatHttpTestCase):
    def dispatch(self, name: str, arguments: dict, request=None) -> Any:
        return _run(
            chat_api._execute_tool_internal(
                name, arguments, request or self.request(), ["front_door"]
            )
        )

    def test_search_objects_response_shapes(self):
        with patch.object(
            chat_api,
            "_execute_search_objects",
            AsyncMock(return_value=JSONResponse(content=[{"id": "a"}])),
        ):
            assert self.dispatch("search_objects", {}) == [{"id": "a"}]

        with patch.object(
            chat_api,
            "_execute_search_objects",
            AsyncMock(return_value=SimpleNamespace(body=b"not json")),
        ):
            assert self.dispatch("search_objects", {}) == {
                "error": "Failed to parse tool result"
            }

        with patch.object(
            chat_api,
            "_execute_search_objects",
            AsyncMock(return_value=SimpleNamespace(content={"raw": True})),
        ):
            assert self.dispatch("search_objects", {}) == {"raw": True}

        with patch.object(
            chat_api, "_execute_search_objects", AsyncMock(return_value=object())
        ):
            assert self.dispatch("search_objects", {}) == {}

    def test_handlers_are_routed(self):
        with (
            patch.object(
                chat_api,
                "_execute_find_similar_objects",
                AsyncMock(return_value={"f": 1}),
            ) as similar,
            patch.object(
                chat_api,
                "_execute_set_camera_state",
                AsyncMock(return_value={"s": 1}),
            ) as state,
            patch.object(
                chat_api,
                "_execute_get_live_context",
                AsyncMock(return_value={"l": 1}),
            ) as live,
            patch.object(
                chat_api,
                "_execute_start_camera_watch",
                AsyncMock(return_value={"w": 1}),
            ) as watch,
            patch.object(
                chat_api, "_execute_stop_camera_watch", return_value={"x": 1}
            ) as stop,
            patch.object(
                chat_api, "_execute_get_profile_status", return_value={"p": 1}
            ) as profile,
            patch.object(
                chat_api, "_execute_get_recap", return_value={"r": 1}
            ) as recap,
        ):
            assert self.dispatch("find_similar_objects", {"a": 1}) == {"f": 1}
            assert self.dispatch("set_camera_state", {"b": 1}) == {"s": 1}
            assert self.dispatch("get_live_context", {"camera": "front_door"}) == {
                "l": 1
            }
            assert self.dispatch("start_camera_watch", {"c": 1}) == {"w": 1}
            assert self.dispatch("stop_camera_watch", {}) == {"x": 1}
            assert self.dispatch("get_profile_status", {}) == {"p": 1}
            assert self.dispatch("get_recap", {"d": 1}) == {"r": 1}

        similar.assert_awaited_once()
        state.assert_awaited_once()
        assert live.await_args.args[1] == "front_door"
        watch.assert_awaited_once()
        stop.assert_called_once()
        profile.assert_called_once()
        recap.assert_called_once_with({"d": 1}, ["front_door"])

    def test_live_context_requires_camera(self):
        result = self.dispatch("get_live_context", {})
        assert "single camera name" in result["error"]
        assert result["available_cameras"] == ["front_door"]


class TestCameraWatchTools(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        self.app.genai_manager = SimpleNamespace(
            chat_client=SimpleNamespace(supports_vision=True)
        )
        access = patch.object(chat_api, "require_camera_access", AsyncMock())
        access.start()
        self.addCleanup(access.stop)

    def start(self, arguments: dict) -> dict:
        return _run(chat_api._execute_start_camera_watch(self.request(), arguments))

    def test_validation_errors(self):
        assert self.start({"camera": "front_door"}) == {
            "error": "camera and condition are required."
        }
        assert self.start({"camera": "garage", "condition": "x"}) == {
            "error": "Camera 'garage' not found."
        }
        self.app.genai_manager = SimpleNamespace(chat_client=None)
        assert (
            "vision" in self.start({"camera": "front_door", "condition": "x"})["error"]
        )

    def test_zones_are_resolved_and_job_started(self):
        with patch.object(
            chat_api, "start_vlm_watch_job", return_value="job-1"
        ) as start:
            result = self.start(
                {
                    "camera": "front_door",
                    "condition": "a package arrives",
                    "zones": ["Front Walkway"],
                    "labels": ["person"],
                    "max_duration_minutes": "15",
                }
            )

        assert result["success"] is True
        assert result["job_id"] == "job-1"
        assert "timeout: 15 min" in result["message"]
        assert start.call_args.kwargs["zones"] == ["front_yard"]
        assert start.call_args.kwargs["max_duration_minutes"] == 15

    def test_job_start_failure(self):
        with patch.object(
            chat_api, "start_vlm_watch_job", side_effect=RuntimeError("busy")
        ):
            result = self.start({"camera": "front_door", "condition": "x"})
        assert result == {"error": "Failed to start VLM watch job."}

    def test_stop_without_job_or_when_stop_fails(self):
        with patch.object(chat_api, "get_vlm_watch_job", return_value=None):
            result = chat_api._execute_stop_camera_watch(self.request())
        assert result["success"] is False

        with (
            patch.object(
                chat_api,
                "get_vlm_watch_job",
                return_value=SimpleNamespace(username="admin"),
            ),
            patch.object(chat_api, "stop_vlm_watch_job", return_value=False),
        ):
            result = chat_api._execute_stop_camera_watch(self.request())
        assert result == {
            "success": False,
            "message": "No active watch job to cancel.",
        }


class TestProfileStatus(_ChatHttpTestCase):
    def test_without_profile_manager(self):
        self.app.profile_manager = None
        assert chat_api._execute_get_profile_status(self.request()) == {
            "error": "Profile manager is not available."
        }

    def test_formats_activation_times(self):
        self.app.profile_manager = MagicMock()
        self.app.profile_manager.get_profile_info.return_value = {
            "active_profile": "away",
            "profiles": ["home", "away"],
            "last_activated": {"away": BASE_TS, "home": "not a time"},
        }
        result = chat_api._execute_get_profile_status(self.request())
        assert result["active_profile"] == "away"
        assert result["profiles"] == ["home", "away"]
        assert result["last_activated"] == {
            "away": "2026-09-01 12:00:00 PM",
            "home": "not a time",
        }


class TestGetRecap(_ChatHttpTestCase):
    WINDOW = {"after": "2026-09-01T11:00:00", "before": "2026-09-01T13:00:00Z"}

    def recap(self, allowed: list[str] | None = None, **arguments) -> dict:
        return chat_api._execute_get_recap(
            {**self.WINDOW, **arguments}, allowed or ["front_door", "back_yard"]
        )

    def test_invalid_window(self):
        assert self.recap(after="soon")["error"] == "Invalid 'after' timestamp: soon"
        assert self.recap(before=None)["error"] == "Invalid 'before' timestamp: None"

    def test_no_accessible_cameras(self):
        result = self.recap(cameras="garage")
        assert result == {"events": [], "message": "No accessible cameras matched."}

    def test_empty_window(self):
        result = self.recap()
        assert result["events"] == []
        assert "No activity" in result["message"]

    def test_events_include_metadata_or_raw_details(self):
        self.insert_mock_review_segment(
            "r1",
            start_time=BASE_TS,
            end_time=BASE_TS + 65.4,
            data={
                "metadata": {
                    "title": "Delivery",
                    "scene": "A courier drops a box",
                    "potential_threat_level": 0,
                },
                "objects": ["person"],
            },
        )
        self.insert_mock_review_segment(
            "r2",
            start_time=BASE_TS + 60,
            end_time=BASE_TS + 90,
            camera="back_yard",
            data={
                "metadata": {"potential_threat_level": 7},
                "objects": ["car"],
                "zones": ["driveway"],
                "audio": ["horn"],
            },
        )
        ReviewSegment.insert(
            id="r3",
            camera="front_door",
            start_time=BASE_TS + 120,
            end_time=None,
            severity="detection",
            thumb_path="",
            data={},
        ).execute()

        result = self.recap()
        first, second, third = result["events"]
        assert first == {
            "camera": "Front Door",
            "severity": "alert",
            "title": "Delivery",
            "description": "A courier drops a box",
            "threat_level": "normal",
            "time": "12:00 PM",
            "duration_seconds": 65,
        }
        assert second["camera"] == "Back Yard"
        assert second["threat_level"] == "7"
        assert second["objects"] == ["car"]
        assert second["zones"] == ["driveway"]
        assert second["audio"] == ["horn"]
        assert third["severity"] == "detection"
        assert "duration_seconds" not in third

    def test_camera_and_severity_filters(self):
        self.insert_mock_review_segment("a", start_time=BASE_TS)
        self.insert_mock_review_segment("b", start_time=BASE_TS, camera="back_yard")
        self.insert_mock_review_segment(
            "c", start_time=BASE_TS, severity="detection", camera="back_yard"
        )

        result = self.recap(cameras="back_yard,garage", severity="detection")
        assert len(result["events"]) == 1
        assert result["events"][0]["severity"] == "detection"

    def test_string_data_and_malformed_times_are_tolerated(self):
        rows = [
            {
                "camera": "front_door",
                "severity": "alert",
                "data": '{"objects": ["dog"]}',
                "start_time": "not a time",
                "end_time": 5.0,
            },
            {
                "camera": "back_yard",
                "severity": "detection",
                "data": "{broken",
                "start_time": None,
                "end_time": None,
            },
        ]
        query = MagicMock()
        query.where.return_value.order_by.return_value.limit.return_value.dicts.return_value.iterator.return_value = iter(
            rows
        )
        with patch.object(ReviewSegment, "select", return_value=query):
            result = self.recap()

        assert result["events"] == [
            {"camera": "Front Door", "severity": "alert", "objects": ["dog"]},
            {"camera": "Back Yard", "severity": "detection"},
        ]

    def test_database_failure(self):
        with patch.object(ReviewSegment, "select", side_effect=RuntimeError("db")):
            result = self.recap()
        assert result == {"error": "Failed to fetch recap data."}


class TestExecutePendingToolsExtra(_ChatHttpTestCase):
    def test_tool_errors_and_exceptions_become_tool_results(self):
        async def fake(name, arguments, request, allowed):
            if name == "boom":
                raise RuntimeError("kaput")
            return {"error": "bad args"}

        with patch.object(chat_api, "_execute_tool_internal", side_effect=fake):
            calls, results, extra = _run(
                chat_api._execute_pending_tools(
                    [
                        {"id": "1", "name": "get_recap", "arguments": {}},
                        {"id": "2", "name": "boom"},
                    ],
                    self.request(),
                    ["front_door"],
                )
            )

        assert json.loads(results[0]["content"]) == {"error": "bad args"}
        assert json.loads(results[1]["content"]) == {
            "error": "Tool execution failed: kaput"
        }
        assert [c.name for c in calls] == ["get_recap", "boom"]
        assert extra == []

    def test_live_image_without_text_gets_default_caption(self):
        with patch.object(
            chat_api,
            "_execute_tool_internal",
            AsyncMock(return_value={"camera": "front_door", "_image_url": "data:x"}),
        ):
            _, results, extra = _run(
                chat_api._execute_pending_tools(
                    [{"id": "1", "name": "get_live_context"}],
                    self.request(),
                    ["front_door"],
                )
            )

        assert json.loads(results[0]["content"]) == {"camera": "front_door"}
        assert extra[0]["content"][0]["text"] == (
            "Here is the current live image from camera 'front_door'."
        )

    def test_string_results_are_passed_through(self):
        with patch.object(
            chat_api, "_execute_tool_internal", AsyncMock(return_value=42)
        ):
            calls, results, _ = _run(
                chat_api._execute_pending_tools(
                    [{"id": "1", "name": "x"}], self.request(), []
                )
            )
        assert results[0]["content"] == "42"
        assert calls[0].response == "42"


class TestChatCompletionHttp(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        self.app.frigate_config.semantic_search.enabled = False

    def test_replayed_tool_messages_keep_ids_and_names(self):
        client = ScriptedClient({"content": "Done", "finish_reason": "stop"})
        self.app.genai_manager = SimpleNamespace(chat_client=client)
        messages = [
            {"role": "system", "content": "pinned"},
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "t1",
                        "type": "function",
                        "function": {"name": "get_recap", "arguments": "{}"},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "t1",
                "name": "get_recap",
                "content": "{}",
            },
        ]
        with AuthTestClient(self.app) as client_http:
            response = client_http.post("/chat/completion", json={"messages": messages})

        assert response.status_code == 200
        sent = client.calls[0]
        assert sent[0] == {"role": "system", "content": "pinned"}
        assert sent[3]["tool_call_id"] == "t1"
        assert sent[3]["name"] == "get_recap"
        assert response.json()["message"]["content"] == "Done"

    def test_search_objects_results_are_trimmed_for_the_model(self):
        self.add_event("e1", label="car", zones=["front_yard"])
        client = ScriptedClient(
            {
                "content": None,
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "search_objects",
                        "arguments": {"label": "car"},
                    }
                ],
                "finish_reason": "tool_calls",
            },
            {"content": "One car.", "finish_reason": "stop"},
        )
        self.app.genai_manager = SimpleNamespace(chat_client=client)

        with AuthTestClient(self.app) as client_http:
            response = client_http.post(
                "/chat/completion",
                json={"messages": [{"role": "user", "content": "any cars?"}]},
            )

        body = response.json()
        assert body["message"]["content"] == "One car."
        assert body["tool_iterations"] == 1
        tool_message = client.calls[1][-1]
        assert tool_message["role"] == "tool"
        events = json.loads(tool_message["content"])
        assert len(events) == 1
        assert events[0]["id"] == "e1"
        assert events[0]["zones"] == ["front_yard"]
        assert "start_time_local" in events[0]
        assert "start_time" not in events[0]
        assert "top_score" not in events[0]


class TestVlmMonitorEndpoints(_ChatHttpTestCase):
    def setUp(self):
        super().setUp()
        self.access = AsyncMock()
        access = patch.object(chat_api, "require_camera_access", self.access)
        access.start()
        self.addCleanup(access.stop)
        self.job = SimpleNamespace(
            username="alice",
            camera="front_door",
            to_dict=lambda: {"camera": "front_door", "condition": "x"},
        )

    def test_start_validation(self):
        self.app.genai_manager = SimpleNamespace(chat_client=None)
        with AuthTestClient(self.app) as client:
            missing = client.post(
                "/vlm/monitor", json={"camera": "garage", "condition": "x"}
            )
            no_vision = client.post(
                "/vlm/monitor", json={"camera": "front_door", "condition": "x"}
            )
        assert missing.status_code == 404
        assert no_vision.status_code == 400

    def test_start_success_and_conflict(self):
        self.app.genai_manager = SimpleNamespace(
            chat_client=SimpleNamespace(supports_vision=True)
        )
        payload = {"camera": "front_door", "condition": "x", "labels": ["person"]}
        with AuthTestClient(self.app) as client:
            with patch.object(
                chat_api, "start_vlm_watch_job", return_value="job-9"
            ) as start:
                created = client.post("/vlm/monitor", json=payload)
            with patch.object(
                chat_api, "start_vlm_watch_job", side_effect=RuntimeError("busy")
            ):
                conflict = client.post("/vlm/monitor", json=payload)

        assert created.status_code == 201
        assert created.json() == {"success": True, "job_id": "job-9"}
        assert start.call_args.kwargs["labels"] == ["person"]
        assert start.call_args.kwargs["username"] == "admin"
        assert conflict.status_code == 409

    def test_get_job_visibility(self):
        viewer = {"remote-user": "bob", "remote-role": "viewer"}
        with AuthTestClient(self.app) as client:
            with patch.object(chat_api, "get_vlm_watch_job", return_value=None):
                none = client.get("/vlm/monitor")
            with patch.object(chat_api, "get_vlm_watch_job", return_value=self.job):
                admin = client.get("/vlm/monitor")
                visible = client.get("/vlm/monitor", headers=viewer)
                self.access.side_effect = HTTPException(status_code=403)
                hidden = client.get("/vlm/monitor", headers=viewer)

        assert none.json() == {"active": False}
        assert admin.json() == {
            "active": True,
            "camera": "front_door",
            "condition": "x",
        }
        assert visible.json()["active"] is True
        assert hidden.json() == {"active": False}

    def test_cancel_job(self):
        viewer = {"remote-user": "bob", "remote-role": "viewer"}
        owner = {"remote-user": "alice", "remote-role": "viewer"}
        with AuthTestClient(self.app) as client:
            with patch.object(chat_api, "get_vlm_watch_job", return_value=None):
                none = client.delete("/vlm/monitor")
            with patch.object(chat_api, "get_vlm_watch_job", return_value=self.job):
                forbidden = client.delete("/vlm/monitor", headers=viewer)
                with patch.object(chat_api, "stop_vlm_watch_job", return_value=False):
                    gone = client.delete("/vlm/monitor", headers=owner)
                with patch.object(
                    chat_api, "stop_vlm_watch_job", return_value=True
                ) as stop:
                    cancelled = client.delete("/vlm/monitor")

        assert none.status_code == 404
        assert forbidden.status_code == 403
        assert gone.status_code == 404
        assert cancelled.status_code == 200
        assert cancelled.json() == {"success": True}
        stop.assert_called_once()
