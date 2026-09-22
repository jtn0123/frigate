import { afterEach, expect, it, vi } from "vitest";
import {
  getEventIdsFromToolCalls,
  streamChatCompletion,
  type StreamChatCallbacks,
} from "./chatUtil";

function callbacks(): StreamChatCallbacks {
  return {
    onContentDelta: vi.fn(),
    onReasoningDelta: vi.fn(),
    onChain: vi.fn(),
    onStats: vi.fn(),
    onApprovalRequired: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
}
function response(chunks: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

it("preserves approval decisions and parses fragmented streams through the final unterminated line", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      response([
        '{"type":"messages","messages":[]}\n{"type":"approval_',
        'required","tool_calls":[{"id":"one","name":"create_export","arguments":{}}]}\n',
        '{"type":"reasoning","delta":"why"}\n{"type":"content","delta":"done"}\n',
        '{"type":"stats","prompt_tokens":10}\n',
        'not-json\n\n{"type":"done"}\n{"type":"content","delta":"!"}',
      ]),
    );
  vi.stubGlobal("fetch", fetch);
  const cb = callbacks();
  await streamChatCompletion("/chat", {}, [], cb, undefined, {
    enableThinking: false,
    toolDecisions: { one: "approve", two: "reject" },
  });
  expect(fetch.mock.calls[0][1]?.body).toBe(
    JSON.stringify({
      messages: [],
      stream: true,
      enable_thinking: false,
      tool_decisions: { one: "approve", two: "reject" },
    }),
  );
  expect(cb.onApprovalRequired).toHaveBeenCalledWith([
    { id: "one", name: "create_export", arguments: {} },
  ]);
  expect(cb.onChain).toHaveBeenCalledWith([]);
  expect(cb.onReasoningDelta).toHaveBeenCalledWith("why");
  expect(cb.onStats).toHaveBeenCalledWith(
    expect.objectContaining({ promptTokens: 10 }),
  );
  expect(cb.onContentDelta).toHaveBeenLastCalledWith("!");
  expect(cb.onError).not.toHaveBeenCalled();
  expect(cb.onDone).toHaveBeenCalledTimes(1);
});

it("tolerates missing optional payloads and approval callback", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        response([
          '{"type":"approval_required"}\n{"type":"messages"}\n{"type":"content"}\n{"type":"reasoning"}\nmalformed',
        ]),
      ),
  );
  const cb = callbacks();
  cb.onApprovalRequired = undefined;
  await streamChatCompletion("/chat", {}, [], cb, undefined, {
    toolDecisions: {},
  });
  expect(cb.onChain).toHaveBeenCalledWith([]);
  expect(cb.onContentDelta).not.toHaveBeenCalled();
  expect(cb.onDone).toHaveBeenCalledTimes(1);
});

it("stops on server errors without processing later content", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        response([
          '{"type":"error","error":"Unavailable"}\n{"type":"content","delta":"ignored"}\n',
        ]),
      ),
  );
  const cb = callbacks();
  await streamChatCompletion("/chat", {}, [], cb);
  expect(cb.onError).toHaveBeenCalledWith("Unavailable");
  expect(cb.onContentDelta).not.toHaveBeenCalled();
  expect(cb.onDone).toHaveBeenCalledTimes(1);
});

it("finishes exactly once on HTTP failure or an empty response body", async () => {
  for (const result of [
    new Response('{"error":"Denied"}', { status: 403 }),
    new Response("invalid", { status: 502, statusText: "Bad Gateway" }),
    new Response(null),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
    const cb = callbacks();
    await streamChatCompletion("/chat", {}, [], cb);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledTimes(1);
  }
});

it("treats cancellation as normal and reports network failures", async () => {
  for (const error of [
    new DOMException("cancelled", "AbortError"),
    new Error("offline"),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    const cb = callbacks();
    await streamChatCompletion("/chat", {}, [], cb);
    expect(cb.onError).toHaveBeenCalledTimes(
      error instanceof DOMException ? 0 : 1,
    );
    expect(cb.onDone).toHaveBeenCalledTimes(1);
  }
});

it("deduplicates event image and search results while ignoring invalid IDs and unrelated tools", () => {
  expect(getEventIdsFromToolCalls(undefined)).toEqual([]);
  expect(
    getEventIdsFromToolCalls([
      {
        name: "search_objects",
        response: JSON.stringify([
          { id: "one" },
          null,
          { id: 3 },
          { other: "value" },
          { id: "two" },
        ]),
      },
      { name: "get_event_image", response: '{"id":"one"}' },
      { name: "get_event_image", response: '{"id":"three"}' },
      { name: "get_event_image", response: "broken" },
      { name: "get_event_image", response: " " },
      { name: "create_export", response: '{"id":"export"}' },
    ]),
  ).toEqual([{ id: "one" }, { id: "two" }, { id: "three" }]);
});
