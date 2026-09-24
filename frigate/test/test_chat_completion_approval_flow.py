"""chat_completion pauses before write tools and resumes with the user's decisions.

Drives the endpoint coroutine directly with a scripted GenAI client, for both
the JSON response and the NDJSON stream (D56)."""

import asyncio
import base64
import json
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import cv2
import numpy as np
from fastapi.responses import StreamingResponse

from frigate.api import chat
from frigate.api.chat import TOOL_REJECTED_RESULT, chat_completion
from frigate.api.defs.request.chat_body import ChatCompletionRequest
from frigate.config import FrigateConfig


def _run(coro):
    return asyncio.run(coro)


def _config() -> FrigateConfig:
    return FrigateConfig(
        mqtt={"enabled": False},
        cameras={
            "front": {
                "ffmpeg": {
                    "inputs": [
                        {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                    ]
                },
                "detect": {"height": 720, "width": 1280, "fps": 5},
            }
        },
    )


WRITE_CALL = {
    "id": "call_w",
    "name": "set_camera_state",
    "arguments": {"camera": "front", "feature": "detect", "value": "OFF"},
}
READ_CALL = {"id": "call_r", "name": "get_recap", "arguments": {}}


def _tool_turn(*calls: dict[str, Any]) -> dict[str, Any]:
    return {"content": None, "tool_calls": list(calls), "finish_reason": "tool_calls"}


def _final(text: str, reasoning: str | None = None) -> dict[str, Any]:
    return {"content": text, "reasoning": reasoning, "finish_reason": "stop"}


class ScriptedClient:
    """Non-streaming client that answers each call with the next response."""

    def __init__(self, *responses: dict[str, Any]):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def chat_with_tools(self, **kwargs):
        self.calls.append(
            {**kwargs, "messages": json.loads(json.dumps(kwargs["messages"]))}
        )
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class StreamingClient:
    """Streaming client whose turns are lists of (kind, value) events."""

    def __init__(self, *turns: list[tuple[str, Any]]):
        self.responses = list(turns)
        self.calls: list[dict[str, Any]] = []

    async def chat_with_tools_stream(self, **kwargs):
        self.calls.append(
            {**kwargs, "messages": json.loads(json.dumps(kwargs["messages"]))}
        )
        for event in self.responses.pop(0):
            yield event


def _request(client, disconnected=None):
    request = SimpleNamespace(
        app=SimpleNamespace(
            frigate_config=_config(),
            genai_manager=SimpleNamespace(chat_client=client),
        ),
        headers={"remote-role": "admin"},
        is_disconnected=AsyncMock(return_value=False),
    )
    if disconnected is not None:
        request.is_disconnected.side_effect = disconnected
    return request


async def _drain(response: StreamingResponse) -> list[dict[str, Any]]:
    lines = []
    async for chunk in response.body_iterator:
        lines.extend(json.loads(line) for line in chunk.splitlines() if line)
    return lines


class ChatFlowTestCase(unittest.TestCase):
    def setUp(self):
        self.executed: list[tuple[str, dict]] = []

        async def fake_tool(name, arguments, request, allowed_cameras):
            self.executed.append((name, arguments))
            return {"ok": name}

        patcher = patch.object(chat, "_execute_tool_internal", side_effect=fake_tool)
        patcher.start()
        self.addCleanup(patcher.stop)
        prompt = patch.object(
            chat, "build_chat_system_prompt", return_value="system prompt"
        )
        prompt.start()
        self.addCleanup(prompt.stop)

    def complete(self, client, messages, **body_kwargs):
        body = ChatCompletionRequest(messages=messages, **body_kwargs)
        return _run(chat_completion(_request(client), body, allowed_cameras=["front"]))

    def stream(self, client, messages, disconnected=None, **body_kwargs):
        body = ChatCompletionRequest(messages=messages, stream=True, **body_kwargs)

        async def go():
            response = await chat_completion(
                _request(client, disconnected), body, allowed_cameras=["front"]
            )
            return await _drain(response)

        return _run(go())


class TestJsonCompletion(ChatFlowTestCase):
    def _pause(self):
        client = ScriptedClient(_tool_turn(WRITE_CALL))
        response = self.complete(client, [{"role": "user", "content": "turn off"}])
        return client, json.loads(response.body)

    def test_write_tool_pauses_for_approval(self):
        client, payload = self._pause()

        self.assertEqual(payload["finish_reason"], "approval_required")
        self.assertEqual(payload["message"]["tool_calls"], [WRITE_CALL])
        self.assertEqual(self.executed, [])
        # the chain the client resends starts with the pinned system prompt
        # and ends with the pending assistant call
        messages = payload["messages"]
        self.assertEqual(messages[0], {"role": "system", "content": "system prompt"})
        self.assertEqual(messages[-1]["tool_calls"][0]["id"], "call_w")
        # the provider never sees Frigate's access field
        for tool in client.calls[0]["tools"]:
            self.assertNotIn("access", tool)

    def test_resume_runs_the_approved_call(self):
        _, paused = self._pause()
        client = ScriptedClient(_final("Detect is off."))

        response = self.complete(
            client, paused["messages"], tool_decisions={"call_w": "approve"}
        )
        payload = json.loads(response.body)

        self.assertEqual(self.executed, [("set_camera_state", WRITE_CALL["arguments"])])
        self.assertEqual(payload["message"]["content"], "Detect is off.")
        self.assertEqual(payload["finish_reason"], "stop")
        # the model is asked again only after the approved call ran
        self.assertEqual(len(client.calls), 1)
        sent = client.calls[0]["messages"]
        self.assertEqual(sum(m["role"] == "system" for m in sent), 1)
        self.assertEqual(sent[-1]["role"], "tool")
        self.assertEqual(json.loads(sent[-1]["content"]), {"ok": "set_camera_state"})

    def test_resume_reports_a_rejected_call_without_running_it(self):
        _, paused = self._pause()
        client = ScriptedClient(_final("Okay, I left it on."))

        self.complete(client, paused["messages"], tool_decisions={"call_w": "reject"})

        self.assertEqual(self.executed, [])
        sent = client.calls[0]["messages"]
        self.assertEqual(sent[-2]["role"], "tool")
        self.assertEqual(json.loads(sent[-2]["content"]), TOOL_REJECTED_RESULT)
        self.assertEqual(sent[-1]["role"], "user")
        self.assertIn("set camera state", sent[-1]["content"][0]["text"])

    def test_read_tool_runs_without_approval(self):
        client = ScriptedClient(_tool_turn(READ_CALL), _final("Quiet day."))

        payload = json.loads(
            self.complete(client, [{"role": "user", "content": "recap"}]).body
        )

        self.assertEqual(self.executed, [("get_recap", {})])
        self.assertEqual(payload["tool_iterations"], 1)
        self.assertEqual(payload["tool_calls"][0]["name"], "get_recap")
        self.assertEqual(payload["message"]["content"], "Quiet day.")

    def test_max_iterations_returns_a_partial_answer(self):
        client = ScriptedClient(_tool_turn(READ_CALL))

        payload = json.loads(
            self.complete(
                client,
                [{"role": "user", "content": "recap"}],
                max_tool_iterations=1,
            ).body
        )

        self.assertEqual(payload["finish_reason"], "length")
        self.assertEqual(payload["tool_iterations"], 1)

    def test_provider_error_is_a_500(self):
        client = ScriptedClient({"finish_reason": "error"})

        response = self.complete(client, [{"role": "user", "content": "hi"}])

        self.assertEqual(response.status_code, 500)

    def test_unexpected_exception_is_a_500(self):
        client = ScriptedClient(RuntimeError("boom"))

        response = self.complete(client, [{"role": "user", "content": "hi"}])

        self.assertEqual(response.status_code, 500)
        self.assertNotIn("boom", response.body.decode())

    def test_missing_chat_client_is_a_400(self):
        response = self.complete(None, [{"role": "user", "content": "hi"}])
        self.assertEqual(response.status_code, 400)

    def test_stream_request_to_a_non_streaming_client_chunks_the_answer(self):
        client = ScriptedClient(_final("It was quiet.", reasoning="checked recap"))

        async def go():
            body = ChatCompletionRequest(
                messages=[{"role": "user", "content": "hi"}], stream=True
            )
            response = await chat_completion(
                _request(client), body, allowed_cameras=["front"]
            )
            return await _drain(response)

        events = _run(go())

        self.assertEqual(events[0]["type"], "messages")
        self.assertEqual(events[1], {"type": "reasoning", "delta": "checked recap"})
        content = "".join(e["delta"] for e in events if e["type"] == "content")
        self.assertEqual(content.strip(), "It was quiet.")
        self.assertEqual(events[-1], {"type": "done"})


class TestStreamingCompletion(ChatFlowTestCase):
    def _pause(self):
        client = StreamingClient(
            [
                ("reasoning_delta", "thinking"),
                ("content_delta", "Turning it off"),
                ("stats", {"prompt_tokens": 3}),
                ("message", _tool_turn(WRITE_CALL)),
            ]
        )
        events = self.stream(client, [{"role": "user", "content": "turn off"}])
        return client, events

    def test_stream_pauses_for_approval(self):
        _, events = self._pause()

        types = [e["type"] for e in events]
        self.assertEqual(
            types,
            ["reasoning", "content", "stats", "messages", "approval_required", "done"],
        )
        self.assertEqual(events[2], {"type": "stats", "prompt_tokens": 3})
        self.assertEqual(events[4]["tool_calls"], [WRITE_CALL])
        self.assertEqual(events[3]["messages"][-1]["tool_calls"][0]["id"], "call_w")
        self.assertEqual(self.executed, [])

    def test_stream_resume_runs_the_call_then_answers(self):
        _, paused = self._pause()
        chain = paused[3]["messages"]
        client = StreamingClient([("message", _final("Detect is off."))])

        events = self.stream(client, chain, tool_decisions={"call_w": "approve"})

        self.assertEqual(self.executed, [("set_camera_state", WRITE_CALL["arguments"])])
        self.assertEqual([e["type"] for e in events], ["messages", "messages", "done"])
        # the first emission carries the tool result, the last the answer
        self.assertEqual(events[0]["messages"][-1]["role"], "tool")
        self.assertEqual(
            events[1]["messages"][-1],
            {"role": "assistant", "content": "Detect is off."},
        )

    def test_stream_read_tool_runs_inline(self):
        client = StreamingClient(
            [("message", _tool_turn(READ_CALL))],
            [("message", _final("Quiet."))],
        )

        events = self.stream(client, [{"role": "user", "content": "recap"}])

        self.assertEqual(self.executed, [("get_recap", {})])
        self.assertEqual(events[-1], {"type": "done"})
        self.assertEqual(events[-2]["messages"][-1]["content"], "Quiet.")

    def test_stream_provider_error(self):
        client = StreamingClient([("message", {"finish_reason": "error"})])

        events = self.stream(client, [{"role": "user", "content": "hi"}])

        self.assertEqual(
            events, [{"type": "error", "error": chat._REQUEST_PROCESSING_ERROR}]
        )

    def test_stream_without_final_message_still_finishes(self):
        client = StreamingClient([("content_delta", "partial")])

        events = self.stream(client, [{"role": "user", "content": "hi"}])

        self.assertEqual([e["type"] for e in events], ["content", "messages", "done"])

    def test_stream_stops_at_max_iterations(self):
        client = StreamingClient([("message", _tool_turn(READ_CALL))])

        events = self.stream(
            client, [{"role": "user", "content": "hi"}], max_tool_iterations=1
        )

        self.assertEqual(len(client.calls), 1)
        self.assertEqual([e["type"] for e in events][-2:], ["messages", "done"])

    def test_disconnect_before_the_model_is_asked(self):
        client = StreamingClient([("message", _final("unused"))])

        events = self.stream(
            client, [{"role": "user", "content": "hi"}], disconnected=[True]
        )

        self.assertEqual(events, [])
        self.assertEqual(client.calls, [])

    def test_disconnect_while_streaming(self):
        client = StreamingClient([("content_delta", "a"), ("content_delta", "b")])

        events = self.stream(
            client, [{"role": "user", "content": "hi"}], disconnected=[False, True]
        )

        self.assertEqual(events, [])

    def test_disconnect_before_tool_execution(self):
        client = StreamingClient([("message", _tool_turn(READ_CALL))])

        events = self.stream(
            client,
            [{"role": "user", "content": "hi"}],
            disconnected=[False, False, True],
        )

        self.assertEqual(events, [])
        self.assertEqual(self.executed, [])


class TestToolDispatch(unittest.TestCase):
    def setUp(self):
        self.request = SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=_config(),
                genai_manager=SimpleNamespace(
                    chat_client=SimpleNamespace(supports_vision=True)
                ),
            ),
            headers={"remote-role": "admin"},
        )

    def test_new_tools_dispatch_to_their_handlers(self):
        with (
            patch.object(
                chat, "_execute_get_export_cases", return_value={"cases": []}
            ) as cases,
            patch.object(
                chat, "_execute_create_export", AsyncMock(return_value={"x": 1})
            ) as export,
            patch.object(
                chat, "_execute_get_event_image", AsyncMock(return_value={"y": 2})
            ) as image,
            patch.object(
                chat,
                "_execute_get_categorized_object_names",
                return_value={"names": {}},
            ) as names,
        ):
            run = chat._execute_tool_internal
            self.assertEqual(
                _run(run("get_export_cases", {}, self.request, ["front"])),
                {"cases": []},
            )
            self.assertEqual(
                _run(run("create_export", {"a": 1}, self.request, ["front"])),
                {"x": 1},
            )
            self.assertEqual(
                _run(run("get_event_image", {"b": 2}, self.request, ["front"])),
                {"y": 2},
            )
            self.assertEqual(
                _run(run("get_categorized_object_names", {}, self.request, ["front"])),
                {"names": {}},
            )

        cases.assert_called_once_with(self.request, ["front"])
        export.assert_awaited_once_with(self.request, {"a": 1}, ["front"])
        image.assert_awaited_once_with(self.request, {"b": 2}, ["front"])
        names.assert_called_once_with(self.request, ["front"])

    def test_unknown_tool(self):
        result = _run(chat._execute_tool_internal("nope", {}, self.request, []))
        self.assertEqual(result, {"error": "Unknown tool: nope"})

    def test_categorized_object_names(self):
        with patch.object(
            chat,
            "get_categorized_object_names",
            return_value={"person": ["Alice"]},
        ) as names:
            self.assertEqual(
                chat._execute_get_categorized_object_names(self.request, ["front"]),
                {"names": {"person": ["Alice"]}},
            )
        names.assert_called_once_with(self.request.app.frigate_config, ["front"])

        with patch.object(chat, "get_categorized_object_names", return_value={}):
            result = chat._execute_get_categorized_object_names(self.request, [])
        self.assertEqual(result["names"], {})
        self.assertIn("semantic_query", result["message"])

    def test_execute_endpoint_returns_categorized_object_names(self):
        body = chat.ToolExecuteRequest(
            tool_name="get_categorized_object_names", arguments={}
        )
        with patch.object(
            chat, "get_categorized_object_names", return_value={"car": ["Mail"]}
        ):
            response = _run(chat.execute_tool(self.request, body, ["front"]))
        self.assertEqual(json.loads(response.body), {"names": {"car": ["Mail"]}})


class TestLiveFrame(unittest.TestCase):
    def _request(self, processor):
        return SimpleNamespace(
            app=SimpleNamespace(
                frigate_config=_config(),
                detected_frames_processor=processor,
                genai_manager=SimpleNamespace(
                    chat_client=SimpleNamespace(supports_vision=True)
                ),
            )
        )

    def test_live_context_without_camera_state(self):
        processor = MagicMock()
        processor.get_camera_state.return_value = None

        result = _run(
            chat._execute_get_live_context(self._request(processor), "front", ["front"])
        )

        self.assertEqual(result, {"error": "Camera 'front' state not available"})

    def test_frame_url_is_none_without_state_or_frame(self):
        processor = MagicMock()
        processor.get_camera_state.return_value = None
        request = self._request(processor)
        self.assertIsNone(
            _run(chat._get_live_frame_image_url(request, "front", ["front"]))
        )

        processor.get_camera_state.return_value = object()
        processor.get_current_frame.return_value = None
        self.assertIsNone(
            _run(chat._get_live_frame_image_url(request, "front", ["front"]))
        )

    def test_frame_is_downscaled_and_encoded(self):
        processor = MagicMock()
        processor.get_current_frame.return_value = np.zeros((960, 1280, 3), np.uint8)

        url = _run(
            chat._get_live_frame_image_url(self._request(processor), "front", ["front"])
        )

        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        decoded = cv2.imdecode(
            np.frombuffer(base64.b64decode(url.split(",", 1)[1]), np.uint8),
            cv2.IMREAD_COLOR,
        )
        self.assertEqual(decoded.shape[:2], (480, 640))

    def test_frame_errors_return_none(self):
        processor = MagicMock()
        processor.get_camera_state.side_effect = RuntimeError("gone")

        self.assertIsNone(
            _run(
                chat._get_live_frame_image_url(
                    self._request(processor), "front", ["front"]
                )
            )
        )


if __name__ == "__main__":
    unittest.main()
