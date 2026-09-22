"""Exercise completion streaming and approval/resume at the API boundary."""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from frigate.api import chat
from frigate.api.defs.request.chat_body import ChatCompletionRequest
from frigate.genai.utils import build_assistant_message_for_conversation

CALL = {
    "id": "write1",
    "name": "set_camera_state",
    "arguments": {"camera": "front", "feature": "detect", "value": "OFF"},
}


class TestChatCompletionBackport(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = SimpleNamespace(chat_with_tools=Mock())
        self.request = SimpleNamespace(
            app=SimpleNamespace(
                genai_manager=SimpleNamespace(chat_client=self.client),
                frigate_config=SimpleNamespace(
                    semantic_search=SimpleNamespace(enabled=False, model="jinav1")
                ),
            ),
            is_disconnected=AsyncMock(return_value=False),
        )
        for name, value in (
            ("get_attribute_classifications", {}),
            ("build_chat_system_prompt", "fixed system prompt"),
        ):
            patcher = patch.object(chat, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def stream(self, batches):
        calls = []
        iterator = iter(batches)

        async def send(**kwargs):
            calls.append({**kwargs, "messages": list(kwargs["messages"])})
            for event in next(iterator):
                yield event

        self.client.chat_with_tools_stream = send
        return calls

    async def complete(self, **kwargs):
        messages = kwargs.pop(
            "messages", [{"role": "user", "content": "Disable detection"}]
        )
        response = await chat.chat_completion(
            self.request, ChatCompletionRequest(messages=messages, **kwargs), ["front"]
        )
        if hasattr(response, "body_iterator"):
            return [json.loads(chunk) async for chunk in response.body_iterator]
        return json.loads(response.body)

    async def test_stream_pauses_before_write_and_returns_replayable_chain(self):
        self.stream([[("message", {"content": None, "tool_calls": [CALL]})]])
        with patch.object(
            chat, "_execute_pending_tools", new_callable=AsyncMock
        ) as execute:
            events = await self.complete(stream=True)
        self.assertEqual(
            [e["type"] for e in events], ["messages", "approval_required", "done"]
        )
        self.assertEqual(events[1]["tool_calls"], [CALL])
        self.assertEqual(events[0]["messages"][0]["content"], "fixed system prompt")
        self.assertEqual(events[0]["messages"][-1]["tool_calls"][0]["id"], "write1")
        execute.assert_not_awaited()

    async def test_stream_resume_approval_executes_once_then_streams_provider_output(
        self,
    ):
        calls = self.stream(
            [
                [
                    ("reasoning_delta", "thinking"),
                    ("content_delta", "Done"),
                    ("stats", {"tokens": 4}),
                    ("message", {"content": "Done"}),
                ]
            ]
        )
        chain = [
            {"role": "system", "content": "pinned prompt"},
            build_assistant_message_for_conversation(None, [CALL]),
        ]
        with patch.object(
            chat,
            "_execute_set_camera_state",
            new_callable=AsyncMock,
            return_value={"success": True},
        ) as execute:
            events = await self.complete(
                stream=True, messages=chain, tool_decisions={"write1": "approve"}
            )
        execute.assert_awaited_once()
        self.assertEqual(
            [e["type"] for e in events],
            ["messages", "reasoning", "content", "stats", "messages", "done"],
        )
        self.assertEqual(calls[0]["messages"][0]["content"], "pinned prompt")
        self.assertEqual(calls[0]["messages"][-1]["role"], "tool")
        self.assertEqual(
            events[-2]["messages"][-1], {"role": "assistant", "content": "Done"}
        )

    async def test_stream_resume_rejection_never_executes_and_informs_provider(self):
        calls = self.stream([[("message", {"content": "What would you prefer?"})]])
        with patch.object(
            chat, "_execute_set_camera_state", new_callable=AsyncMock
        ) as execute:
            await self.complete(
                stream=True,
                messages=[build_assistant_message_for_conversation(None, [CALL])],
                tool_decisions={"write1": "reject"},
            )
        execute.assert_not_awaited()
        self.assertEqual(
            json.loads(calls[0]["messages"][-2]["content"]), {"error": "user_rejected"}
        )
        self.assertIn(
            "do not want to proceed", calls[0]["messages"][-1]["content"][0]["text"]
        )

    async def test_stream_executes_read_tools_and_continues_with_results(self):
        read = {"id": "read1", "name": "get_export_cases", "arguments": {}}
        calls = self.stream(
            [
                [("message", {"tool_calls": [read]})],
                [("message", {"content": "No cases"})],
            ]
        )
        with patch.object(
            chat, "_execute_get_export_cases", return_value={"cases": []}
        ) as execute:
            events = await self.complete(stream=True)
        execute.assert_called_once_with(self.request, ["front"])
        self.assertEqual(calls[1]["messages"][-1]["tool_call_id"], "read1")
        self.assertEqual(events[-1]["type"], "done")
        self.assertNotIn("approval_required", [e["type"] for e in events])

    async def test_stream_handles_disconnect_provider_error_and_incomplete_stream(self):
        self.stream([[("content_delta", "partial")]])
        self.request.is_disconnected.return_value = True
        self.assertEqual(await self.complete(stream=True), [])
        self.request.is_disconnected.return_value = False
        self.request.is_disconnected.side_effect = [False, True]
        self.assertEqual(await self.complete(stream=True), [])
        self.request.is_disconnected.side_effect = None
        self.stream([[("message", {"finish_reason": "error"})]])
        self.assertEqual((await self.complete(stream=True))[0]["type"], "error")
        self.stream([[]])
        self.assertEqual(
            [e["type"] for e in await self.complete(stream=True)], ["messages", "done"]
        )

    async def test_disconnect_before_resumed_write_never_executes(self):
        self.stream([])
        self.request.is_disconnected.side_effect = [False, True]
        with patch.object(
            chat, "_execute_pending_tools", new_callable=AsyncMock
        ) as execute:
            events = await self.complete(
                stream=True,
                messages=[build_assistant_message_for_conversation(None, [CALL])],
                tool_decisions={"write1": "approve"},
            )
        self.assertEqual(events, [])
        execute.assert_not_awaited()

    async def test_nonstream_pauses_and_resumes_with_the_same_decision_contract(self):
        self.client.chat_with_tools.return_value = {
            "content": None,
            "tool_calls": [CALL],
        }
        with patch.object(
            chat, "_execute_set_camera_state", new_callable=AsyncMock
        ) as execute:
            paused = await self.complete()
            execute.assert_not_awaited()
            self.assertEqual(paused["finish_reason"], "approval_required")
            self.client.chat_with_tools.return_value = {
                "content": "Cancelled",
                "finish_reason": "stop",
            }
            resumed = await self.complete(
                messages=paused["messages"], tool_decisions={"write1": "reject"}
            )
            execute.assert_not_awaited()
        self.assertEqual(resumed["message"]["content"], "Cancelled")
        self.assertEqual(resumed["tool_calls"][0]["name"], "set_camera_state")

    async def test_nonstream_provider_can_supply_chunked_stream_and_iteration_limit(
        self,
    ):
        self.client.chat_with_tools.return_value = {
            "content": "All done",
            "reasoning": "Reason",
        }
        events = await self.complete(stream=True)
        self.assertEqual(events[1], {"type": "reasoning", "delta": "Reason"})
        self.assertEqual(
            "".join(e["delta"] for e in events if e["type"] == "content"), "All done"
        )
        self.client.chat_with_tools.return_value = {"tool_calls": [CALL]}
        with patch.object(
            chat,
            "_execute_set_camera_state",
            new_callable=AsyncMock,
            return_value={"success": True},
        ):
            result = await self.complete(
                max_tool_iterations=1, tool_decisions={"write1": "approve"}
            )
        self.assertEqual(result["finish_reason"], "length")
        self.assertEqual(result["tool_iterations"], 1)

    async def test_nonstream_provider_errors_are_sanitized(self):
        for result in (
            {"finish_reason": "error"},
            RuntimeError("private provider detail"),
        ):
            with (
                self.subTest(result=result),
                self.assertLogs(chat.logger, level="ERROR"),
            ):
                self.client.chat_with_tools.side_effect = (
                    result if isinstance(result, Exception) else None
                )
                self.client.chat_with_tools.return_value = result
                response = await self.complete()
                self.assertNotIn("private provider detail", json.dumps(response))
                self.assertIn("error", response)
