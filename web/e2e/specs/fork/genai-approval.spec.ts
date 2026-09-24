import { test, expect } from "../../fixtures/frigate-test";

for (const decision of ["approve", "reject"] as const) {
  test(`GenAI action waits for ${decision} and resumes the same conversation @medium @mobile`, async ({
    frigateApp,
  }) => {
    const requests: Array<Record<string, unknown>> = [];
    const pending = {
      id: "export-1",
      name: "create_export",
      arguments: { camera: "front_door", start_time: 100, end_time: 200 },
    };
    const chain = [
      { role: "user", content: "Export the front door clip" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: pending.id,
            type: "function",
            function: {
              name: pending.name,
              arguments: JSON.stringify(pending.arguments),
            },
          },
        ],
      },
    ];
    await frigateApp.page.route("**/chat/completion", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const chunks = body.tool_decisions
        ? [
            { type: "content", delta: `Action ${decision} received` },
            {
              type: "messages",
              messages: [
                ...chain,
                { role: "assistant", content: `Action ${decision} received` },
              ],
            },
          ]
        : [
            { type: "messages", messages: chain },
            { type: "approval_required", tool_calls: [pending] },
          ];
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
      });
    });
    await frigateApp.goto("/chat");
    const composer = frigateApp.page.getByPlaceholder(/ask/i);
    await composer.fill("Export the front door clip");
    await composer.press("Enter");

    const approval = frigateApp.page.getByRole("group", {
      name: /Approve Create Export/i,
    });
    await expect(approval).toBeVisible();
    await expect(approval).toContainText("front_door");
    await expect(
      frigateApp.page.getByPlaceholder(/approve or reject/i),
    ).toBeDisabled();
    expect(requests).toHaveLength(1);

    await approval
      .getByRole("button", {
        name: decision === "approve" ? "Approve" : "Reject",
        exact: true,
      })
      .click();
    await expect(
      frigateApp.page.getByText(`Action ${decision} received`),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.["tool_decisions"]).toEqual({ "export-1": decision });
    expect(requests[1]?.["messages"]).toEqual(chain);
    await expect(
      frigateApp.page.getByRole("group", { name: /Approve Create Export/i }),
    ).toHaveCount(0);
  });
}
