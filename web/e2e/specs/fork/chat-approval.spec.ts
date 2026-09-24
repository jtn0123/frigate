/**
 * Fork: chat tool call approval (D56, backport of upstream #24173).
 *
 * When the assistant wants to run a state-changing tool the backend pauses
 * the turn with an `approval_required` chunk. The page shows an approval
 * card and blocks the composer; approving resends the chain with the
 * decision in `tool_decisions`.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

type Chunk = Record<string, unknown>;

/**
 * Serve one NDJSON body per chat/completion request, in order, and record
 * each request body on `window.__chatRequests`. page.route() cannot stream,
 * so this overrides window.fetch like the upstream chat spec does.
 */
async function installChatResponses(app: FrigateApp, responses: Chunk[][]) {
  await app.page.addInitScript((responses) => {
    const w = window as unknown as { __chatRequests: unknown[] };
    w.__chatRequests = [];
    const origFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (!url.includes("chat/completion")) {
        return origFetch.call(window, input as RequestInfo, init);
      }
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const index = w.__chatRequests.length;
      w.__chatRequests.push(body);
      const chunks = responses[Math.min(index, responses.length - 1)] ?? [];
      const text = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
      return new Response(text, { status: 200 });
    };
  }, responses);
}

const pausedChain = [
  { role: "system", content: "sys" },
  { role: "user", content: "turn off detection on front door" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "set_camera_state",
          arguments: '{"camera":"front_door","feature":"detect","value":"OFF"}',
        },
      },
    ],
  },
];

const approvalTurn: Chunk[] = [
  { type: "messages", messages: pausedChain },
  {
    type: "approval_required",
    tool_calls: [
      {
        id: "call_1",
        name: "set_camera_state",
        arguments: { camera: "front_door", feature: "detect", value: "OFF" },
      },
    ],
  },
  { type: "done" },
];

const resumedTurn: Chunk[] = [
  {
    type: "messages",
    messages: [
      ...pausedChain,
      { role: "tool", tool_call_id: "call_1", content: '{"success":true}' },
    ],
  },
  { type: "content", delta: "Detection is off." },
  {
    type: "messages",
    messages: [
      ...pausedChain,
      { role: "tool", tool_call_id: "call_1", content: '{"success":true}' },
      { role: "assistant", content: "Detection is off." },
    ],
  },
  { type: "done" },
];

test.describe("Chat, tool call approval @medium @mobile", () => {
  test("a write tool waits for approval and resumes with the decision", async ({
    frigateApp,
  }) => {
    await installChatResponses(frigateApp, [approvalTurn, resumedTurn]);
    const { page } = frigateApp;
    await frigateApp.goto("/chat");
    const input = page.getByPlaceholder(/ask/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill("turn off detection on front door");
    await input.press("Enter");

    const card = page.getByRole("group", { name: /set camera state/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('"feature": "detect"');
    await expect(
      page.getByPlaceholder(/approve or reject the pending action/i),
    ).toBeDisabled();

    await card.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByText("Detection is off.")).toBeVisible({
      timeout: 10_000,
    });
    const requests = await page.evaluate(
      () => (window as unknown as { __chatRequests: unknown[] }).__chatRequests,
    );
    expect(requests).toHaveLength(2);
    const resume = requests[1] as {
      tool_decisions?: Record<string, string>;
      messages: Array<{ role: string }>;
    };
    expect(resume.tool_decisions).toEqual({ call_1: "approve" });
    expect(resume.messages.at(-1)?.role).toBe("assistant");
    await expect(page.getByPlaceholder(/ask/i)).toBeEnabled();
  });
});
