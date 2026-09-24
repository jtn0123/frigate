import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, PendingToolCall } from "@/types/chat";
import type { StreamChatCallbacks, StreamChatOptions } from "@/utils/chatUtil";
import ChatPage from "../Chat";

/** Reads an index the test has just asserted exists. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`missing item ${index}`);
  }
  return item;
}

type StreamScript = (
  callbacks: StreamChatCallbacks,
  messages: ChatMessage[],
) => void;

const stream = vi.hoisted(() => ({
  scripts: [] as StreamScript[],
  calls: [] as { messages: ChatMessage[]; options: StreamChatOptions }[],
}));

const idb = vi.hoisted(() => new Map<string, unknown>());

vi.mock("idb-keyval", () => ({
  get: async (key: string) => idb.get(key),
  set: async (key: string, value: unknown) => {
    idb.set(key, value);
  },
  del: async (key: string) => {
    idb.delete(key);
  },
}));

vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

vi.mock("@/utils/chatUtil", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chatUtil")>()),
  streamChatCompletion: async (
    _url: string,
    _headers: Record<string, string>,
    messages: ChatMessage[],
    callbacks: StreamChatCallbacks,
    _signal?: AbortSignal,
    options: StreamChatOptions = {},
  ) => {
    stream.calls.push({ messages, options });
    const script = stream.scripts.shift();
    if (script) script(callbacks, messages);
  },
}));

// The page is the unit under test: its children are reduced to the props the
// approval flow drives (the approval card itself stays real).
vi.mock("@/components/chat/ChatStartingState", () => ({
  ChatStartingState: ({
    onSendMessage,
  }: {
    onSendMessage: (message: string) => void;
  }) => (
    <button type="button" onClick={() => onSendMessage("turn off detect")}>
      start
    </button>
  ),
}));

vi.mock("@/components/chat/ChatComposer", () => ({
  ChatComposer: ({
    placeholder,
    disabled,
    onStop,
    sendMessage,
  }: {
    placeholder: string;
    disabled?: boolean;
    onStop: () => void;
    sendMessage: (text?: string) => void;
  }) => (
    <div>
      <textarea
        aria-label="composer"
        placeholder={placeholder}
        disabled={disabled}
      />
      <button type="button" onClick={() => sendMessage("and the back yard")}>
        send
      </button>
      <button type="button" onClick={onStop}>
        stop
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/ChatSettings", () => ({
  default: ({
    alwaysAllowTools,
    clearAlwaysAllowTools,
  }: {
    alwaysAllowTools: string[];
    clearAlwaysAllowTools: () => void;
  }) => (
    <div>
      <span data-testid="always-allow">{alwaysAllowTools.join(",")}</span>
      <button type="button" onClick={clearAlwaysAllowTools}>
        clear always allow
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/ChatMessage", () => ({
  MessageBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("@/components/chat/ToolCallsGroup", () => ({
  ToolCallsGroup: () => null,
}));
vi.mock("@/components/chat/ReasoningBubble", () => ({
  ReasoningBubble: () => null,
}));
vi.mock("@/components/chat/ChatEventThumbnailsRow", () => ({
  ChatEventThumbnailsRow: () => null,
}));

function call(id: string, name = "set_camera_state"): PendingToolCall {
  return { id, name, arguments: { camera: "front" } };
}

function assistantRequesting(calls: PendingToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    })),
  };
}

// A turn that pauses on the given write tool calls.
function pauseOn(calls: PendingToolCall[]): StreamScript {
  return (cb, messages) => {
    cb.onChain([...messages, assistantRequesting(calls)]);
    cb.onApprovalRequired?.(calls);
    cb.onDone();
  };
}

// A turn that finishes with a final answer.
function answer(text: string): StreamScript {
  return (cb, messages) => {
    cb.onChain([...messages, { role: "assistant", content: text }]);
    cb.onDone();
  };
}

async function startChat() {
  render(<ChatPage />);
  fireEvent.click(screen.getByRole("button", { name: "start" }));
}

const cards = () => screen.queryAllByRole("group", { name: "approval.title" });

describe("ChatPage tool approval (D56)", () => {
  beforeEach(() => {
    // jsdom does not implement element scrolling; the page auto-scrolls
    Element.prototype.scrollTo = vi.fn();
    stream.scripts = [];
    stream.calls = [];
    idb.clear();
  });

  it("pauses on a write tool and resumes with the approval", async () => {
    stream.scripts.push(pauseOn([call("a")]), answer("Detect is off."));
    await startChat();

    expect(await screen.findAllByRole("group")).toHaveLength(1);
    const composer = screen.getByLabelText("composer");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", "approval.placeholder");

    fireEvent.click(screen.getByRole("button", { name: "approval.approve" }));

    expect(await screen.findByText("Detect is off.")).toBeInTheDocument();
    expect(stream.calls).toHaveLength(2);
    const resumed = nth(stream.calls, 1);
    expect(resumed.options.toolDecisions).toEqual({ a: "approve" });
    // the resend ends with the assistant's pending calls, not a user message
    expect(resumed.messages.at(-1)?.role).toBe("assistant");
    expect(resumed.messages.at(-1)?.tool_calls?.[0]?.id).toBe("a");
    expect(cards()).toHaveLength(0);
    expect(screen.getByLabelText("composer")).toHaveAttribute(
      "placeholder",
      "placeholder",
    );
  });

  it("waits for every pending call before resuming with mixed decisions", async () => {
    stream.scripts.push(
      pauseOn([call("a"), call("b", "create_export")]),
      answer("Only the export ran."),
    );
    await startChat();
    await waitFor(() => expect(cards()).toHaveLength(2));

    const first = nth(cards(), 0);
    fireEvent.click(
      first.querySelector("button:last-of-type") as HTMLButtonElement,
    );
    // one call is still undecided, so nothing is sent yet
    expect(stream.calls).toHaveLength(1);
    expect(screen.getByText("approval.rejected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "approval.approve" }));

    expect(await screen.findByText("Only the export ran.")).toBeInTheDocument();
    expect(nth(stream.calls, 1).options.toolDecisions).toEqual({
      a: "reject",
      b: "approve",
    });
  });

  it("always allow approves matching calls now and answers for them later", async () => {
    stream.scripts.push(
      pauseOn([call("a"), call("b"), call("c", "create_export")]),
      answer("Done."),
      pauseOn([call("d")]),
      answer("Done again."),
    );
    await startChat();
    await waitFor(() => expect(cards()).toHaveLength(3));

    fireEvent.click(
      nth(screen.getAllByRole("button", { name: "approval.always_allow" }), 0),
    );
    // both set_camera_state calls are approved; the export still waits
    expect(screen.getAllByText("approval.approved")).toHaveLength(2);
    expect(stream.calls).toHaveLength(1);
    expect(screen.getByTestId("always-allow")).toHaveTextContent(
      "set_camera_state",
    );
    await waitFor(() =>
      expect(idb.get("chat-always-allow-tools")).toEqual(["set_camera_state"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "approval.approve" }));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(nth(stream.calls, 1).options.toolDecisions).toEqual({
      a: "approve",
      b: "approve",
      c: "approve",
    });

    // A later pause on an always-allowed tool resumes without a prompt.
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(await screen.findByText("Done again.")).toBeInTheDocument();
    expect(stream.calls).toHaveLength(4);
    expect(nth(stream.calls, 3).options.toolDecisions).toEqual({
      d: "approve",
    });
    expect(cards()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "clear always allow" }));
    expect(screen.getByTestId("always-allow")).toBeEmptyDOMElement();
    await waitFor(() => expect(idb.get("chat-always-allow-tools")).toEqual([]));
  });

  it("uses the persisted always allow list for the first pause", async () => {
    idb.set("chat-always-allow-tools", ["set_camera_state"]);
    stream.scripts.push(
      pauseOn([call("a"), call("b", "create_export")]),
      answer("Done."),
    );
    render(<ChatPage />);
    await waitFor(() =>
      expect(screen.getByTestId("always-allow")).toHaveTextContent(
        "set_camera_state",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "start" }));

    // only the call that is not always allowed still needs the user
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getAllByText("approval.approved")).toHaveLength(1);
    expect(stream.calls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "approval.reject" }));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(nth(stream.calls, 1).options.toolDecisions).toEqual({
      a: "approve",
      b: "reject",
    });
  });

  it("stop and new chat drop a pending approval", async () => {
    stream.scripts.push(pauseOn([call("a")]));
    await startChat();
    await waitFor(() => expect(cards()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    expect(cards()).toHaveLength(0);
    expect(screen.getByLabelText("composer")).toBeEnabled();

    stream.scripts.push(pauseOn([call("b")]));
    fireEvent.click(screen.getByRole("button", { name: "new_chat" }));
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(cards()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "new_chat" }));
    expect(cards()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "start" })).toBeInTheDocument();
  });

  it("does not prompt for approval when the turn ended in an error", async () => {
    stream.scripts.push((cb, messages) => {
      cb.onChain([...messages, assistantRequesting([call("a")])]);
      cb.onApprovalRequired?.([call("a")]);
      cb.onError("provider failed");
      cb.onDone();
    });
    await startChat();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "provider failed",
    );
    expect(cards()).toHaveLength(0);
    expect(stream.calls).toHaveLength(1);
  });
});
