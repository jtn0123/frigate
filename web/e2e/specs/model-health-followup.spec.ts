import { test, expect } from "../fixtures/frigate-test";
import { writeFileSync } from "node:fs";
const inventory = {
  updated: 1789229600,
  telemetry_status: "connected",
  history_status: "connected",
  server: { status: "connected", scopes: [] },
  audio: {
    status: "connected",
    pending: 2,
    completed: 14,
    failed: 1,
    expired: 0,
    oldest_wait_seconds: 12,
    available_bytes: 6 * 1024 ** 3,
    pause_reason: "memory",
  },
  shared_gpus: { "AMD RX 6800 XT": { gpu: "22 %", mem: "81 %", temp: 51 } },
  models: [
    {
      id: "audio:medium",
      name: "Whisper Medium",
      role: "speech_translation",
      location: "audio_worker",
      device: "CPU",
      status: "cached",
      resource_scope: "process",
      disk_bytes: 1600000000,
      ram_bytes: 0,
      cpu_percent: 0,
      gpu_memory_bytes: 0,
      latency_ms: 12000,
      load_ms: 2300,
      peak_ram_bytes: 3100000000,
      last_used: null,
    },
    {
      id: "genai:local",
      name: "qwen3-vl:8b-instruct",
      role: "generative_ai",
      location: "ollama",
      device: "GPU",
      status: "loaded",
      resource_scope: "model_allocation",
      disk_bytes: 6000000000,
      ram_bytes: null,
      cpu_percent: null,
      gpu_memory_bytes: 11000000000,
      latency_ms: null,
      load_ms: null,
      peak_ram_bytes: null,
      last_used: null,
      context_length: 32768,
    },
  ],
};

test("prioritizes queue and captures models and health @medium @mobile", async ({
  frigateApp,
}, info) => {
  const page = frigateApp.page;
  await page.route("**/api/ai/models", (route) =>
    route.fulfill({ json: { ...inventory, updated: Date.now() / 1000 } }),
  );
  await page.route("**/api/ai/models/history", (route) =>
    route.fulfill({ json: { status: "connected", samples: [] } }),
  );
  const started = Date.now();
  await frigateApp.goto("/system#general");
  await expect(page.getByLabel("Select general")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("general-.png"),
  });
  await page.getByLabel("Select models").click();
  await expect(
    page.getByRole("article", { name: "Whisper Medium" }),
  ).toBeVisible();
  const queue = await page
    .getByRole("region", { name: "Audio analysis queue" })
    .boundingBox();
  expect(queue?.y).toBeLessThan(650);
  writeFileSync(
    info.outputPath("layout-.json"),
    JSON.stringify(
      {
        navigationAndSetupMs: Date.now() - started,
        viewport: page.viewportSize(),
        queue,
        accessibleCharts: await page.locator(".apexcharts-canvas").count(),
      },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: info.outputPath("models-.png"),
  });
  await page
    .getByRole("region", { name: "Audio analysis queue" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("models-details-.png"),
  });
  await page.getByLabel("Select health").click();
  await expect(page.getByTestId("camera-health-grid")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("health-.png"),
  });
});
test("audit unavailable model endpoint @mobile", async ({
  frigateApp,
}, info) => {
  await frigateApp.page.route("**/api/ai/models", (route) =>
    route.fulfill({ status: 503, json: { message: "unavailable" } }),
  );
  await frigateApp.goto("/system#models");
  await expect(
    frigateApp.page.getByRole("button", { name: /retry/i }),
  ).toBeVisible();
  await expect(
    frigateApp.page.getByText("System is healthy", { exact: true }),
  ).toHaveCount(0);
  await frigateApp.page.screenshot({
    path: info.outputPath("models-error-.png"),
  });
});
test("audit empty model inventory @mobile", async ({ frigateApp }, info) => {
  await frigateApp.page.route("**/api/ai/models", (route) =>
    route.fulfill({
      json: {
        updated: Date.now() / 1000,
        models: [],
        audio: { status: "not_connected" },
        shared_gpus: {},
      },
    }),
  );
  await frigateApp.goto("/system#models");
  await expect(
    frigateApp.page.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveCount(0);
  await frigateApp.page.screenshot({
    path: info.outputPath("models-empty-.png"),
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`model explanations and history values work in ${theme} @medium @mobile`, async ({
    frigateApp,
  }, info) => {
    const page = frigateApp.page;
    await page.addInitScript(
      (theme) =>
        localStorage.setItem(
          "frigate-ui-theme",
          JSON.stringify({ theme, colorScheme: "theme-default" }),
        ),
      theme,
    );
    const now = Date.now() / 1000;
    await page.route("**/api/ai/models", (route) =>
      route.fulfill({ json: { ...inventory, updated: now } }),
    );
    await page.route("**/api/ai/models/history", (route) =>
      route.fulfill({
        json: {
          status: "connected",
          samples: Array.from({ length: 30 }, (_, i) => ({
            ...inventory,
            updated: now - (30 - i) * 60,
            models: inventory.models.map((model) => ({
              ...model,
              ram_bytes: model.ram_bytes == null ? null : i * 1024 ** 2,
            })),
          })),
        },
      }),
    );
    await frigateApp.goto("/system#models");
    const explanation = page
      .getByRole("article", { name: "qwen3-vl:8b-instruct" })
      .locator("summary")
      .first();
    await explanation.focus();
    await page.keyboard.press("Enter");
    await expect(explanation.locator("..")).toHaveAttribute("open", "");
    await page.locator("summary").filter({ hasText: "Model history" }).click();
    const tableToggle = page
      .locator("summary")
      .filter({ hasText: "View values:" })
      .first();
    await tableToggle.click();
    const details = tableToggle.locator("..");
    await expect(details.getByRole("table")).toBeVisible();
    await expect(details.getByRole("row")).toHaveCount(26);
    await details.getByRole("button", { name: "Next", exact: true }).click();
    await expect(details.getByText(/Page 2 of/)).toBeVisible();
    await expect(page.locator(".apexcharts-line").first()).toBeVisible();
    const stroke = await page
      .locator(".apexcharts-line")
      .first()
      .getAttribute("stroke");
    expect(stroke).not.toBe("#3b82f6");
    expect(stroke).not.toBeNull();
    await page
      .getByRole("region", { name: "Process RAM over time", exact: true })
      .screenshot({ path: info.outputPath(`history-table-${theme}.png`) });
    await page
      .getByRole("article", { name: "qwen3-vl:8b-instruct" })
      .screenshot({ path: info.outputPath(`metric-help-${theme}.png`) });
    await expect(page.locator("body")).toHaveJSProperty(
      "scrollWidth",
      await page.locator("body").evaluate((el) => el.clientWidth),
    );
  });
}
