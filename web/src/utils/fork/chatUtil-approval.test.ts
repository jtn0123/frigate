import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatToolName,
  getEventIdsFromToolCalls,
  streamChatCompletion,
  toolCallsForMessage,
} from "../chatUtil";

// D56: tool call approval and the get_event_image tool (upstream #24173)

function ndjsonResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  return new Response(body, { status: 200 });
}

function callbacks() {
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

function sentBody(
  fetchMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatToolName", () => {
  it("title-cases snake case names", () => {
    expect(formatToolName("create_export")).toBe("Create Export");
    expect(formatToolName("GET_event_IMAGE")).toBe("Get Event Image");
  });
});

describe("getEventIdsFromToolCalls", () => {
  it("collects ids from search_objects lists and get_event_image objects", () => {
    const ids = getEventIdsFromToolCalls([
      {
        name: "search_objects",
        arguments: {},
        response: JSON.stringify([{ id: "a" }, { id: "b" }, { nope: 1 }]),
      },
      {
        name: "get_event_image",
        arguments: {},
        response: JSON.stringify({ id: "a" }),
      },
      {
        name: "get_event_image",
        arguments: {},
        response: JSON.stringify({ id: "c" }),
      },
      { name: "set_camera_state", arguments: {}, response: '{"id":"x"}' },
      { name: "search_objects", arguments: {}, response: "not json" },
      { name: "search_objects", arguments: {}, response: "  " },
    ]);
    expect(ids).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(getEventIdsFromToolCalls(undefined)).toEqual([]);
  });
});

describe("toolCallsForMessage", () => {
  it("keeps the call id so approvals can be matched", () => {
    const calls = toolCallsForMessage(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "create_export", arguments: "{}" },
          },
        ],
      },
      new Map([["call_1", "ok"]]),
    );
    expect(calls[0]).toMatchObject({ id: "call_1", response: "ok" });
  });
});

describe("streamChatCompletion approval", () => {
  it("reports approval_required and sends tool_decisions on resume", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: "messages", messages: [] },
        {
          type: "approval_required",
          tool_calls: [{ id: "call_1", name: "create_export", arguments: {} }],
        },
        { type: "done" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cb = callbacks();

    await streamChatCompletion("/api/chat/completion", {}, [], cb, undefined, {
      toolDecisions: { call_1: "approve" },
    });

    expect(cb.onApprovalRequired).toHaveBeenCalledWith([
      { id: "call_1", name: "create_export", arguments: {} },
    ]);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(sentBody(fetchMock)["tool_decisions"]).toEqual({
      call_1: "approve",
    });
  });

  it("omits tool_decisions when there are none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ndjsonResponse([{ type: "done" }]));
    vi.stubGlobal("fetch", fetchMock);

    await streamChatCompletion(
      "/api/chat/completion",
      {},
      [],
      callbacks(),
      undefined,
      { toolDecisions: {} },
    );

    expect(sentBody(fetchMock)).not.toHaveProperty("tool_decisions");
  });
});
