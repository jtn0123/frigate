import { test, expect } from "../fixtures/frigate-test";

const inventory = {
  updated: 1789229600,
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

test.describe("AI model status @medium @mobile", () => {
  test.beforeEach(async ({ frigateApp }) => {
    await frigateApp.page.route("**/api/ai/models/history", (route) =>
      route.fulfill({ json: { status: "connected", samples: [] } }),
    );
  });
  test("shows measured and unavailable resources with shared GPU context", async ({
    frigateApp,
  }, testInfo) => {
    await frigateApp.page.route("**/api/ai/models", (route) =>
      route.fulfill({ json: inventory }),
    );
    await frigateApp.goto("/system#general");
    await expect(frigateApp.page.getByLabel("Select general")).toHaveAttribute(
      "data-state",
      "on",
    );
    await frigateApp.page.screenshot({
      path: testInfo.outputPath("before-system.png"),
      fullPage: true,
    });
    await frigateApp.page.getByLabel("Select AI Models").click();
    await frigateApp.page
      .locator("summary")
      .filter({ hasText: "Model history" })
      .click();
    const medium = frigateApp.page.getByRole("article", {
      name: "Whisper Medium",
    });
    await expect(medium).toBeVisible();
    await expect(medium.getByText("On disk", { exact: true })).toBeVisible();
    const ollama = frigateApp.page.getByRole("article", {
      name: "qwen3-vl:8b-instruct",
    });
    await expect(
      ollama.getByText("Collector needed", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("region", {
        name: "Model history",
        exact: true,
      }),
    ).toBeVisible();
    await frigateApp.page
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("genai:local");
    await expect(
      frigateApp.page.getByRole("region", {
        name: "Process RAM over time",
        exact: true,
      }),
    ).toContainText("No readings yet");
    await frigateApp.page
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("audio:medium");
    await expect(
      frigateApp.page
        .getByRole("region", { name: "Process RAM over time", exact: true })
        .locator(".apexcharts-canvas"),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByText("Waiting for spare memory", { exact: true }),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("region", { name: "Shared GPU", exact: true }),
    ).toBeVisible();
    await expect(frigateApp.page.locator("body")).not.toContainText(
      "models.states",
    );
    await expect
      .poll(() =>
        frigateApp.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await frigateApp.page.screenshot({
      path: testInfo.outputPath("after-ai-models.png"),
      fullPage: true,
    });
  });

  test("accumulates successive readings into graphs", async ({
    frigateApp,
  }, testInfo) => {
    let samples = 0;
    await frigateApp.page.clock.install();
    await frigateApp.page.route("**/api/ai/models", (route) => {
      samples += 1;
      return route.fulfill({
        json: { ...inventory, updated: inventory.updated + samples * 10 },
      });
    });
    await frigateApp.goto("/system#models");
    await frigateApp.page
      .locator("summary")
      .filter({ hasText: "Model history" })
      .click();
    const waiting = frigateApp.page.getByText(
      "The first reading is shown now. A trend appears after the next sample.",
      { exact: true },
    );
    await expect(waiting).toBeVisible();
    await frigateApp.page.clock.runFor(21000);
    await expect.poll(() => samples).toBeGreaterThan(1);
    await expect(waiting).toHaveCount(0);
    await expect(
      frigateApp.page
        .getByRole("region", { name: "Process RAM over time", exact: true })
        .locator(".apexcharts-canvas"),
    ).toBeVisible();
    await frigateApp.page.screenshot({
      path: testInfo.outputPath("after-graphs.png"),
      fullPage: true,
    });
  });

  test("stale worker data is visible without hiding Ollama", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route("**/api/ai/models", (route) =>
      route.fulfill({
        json: {
          ...inventory,
          audio: { status: "stale" },
          models: inventory.models.map((model) =>
            model.id.startsWith("audio:")
              ? {
                  ...model,
                  status: "stale",
                  ram_bytes: null,
                  cpu_percent: null,
                }
              : model,
          ),
        },
      }),
    );
    await frigateApp.goto("/system#models");
    await frigateApp.page
      .locator("summary")
      .filter({ hasText: "Model history" })
      .click();
    await expect(
      frigateApp.page.getByText("Worker readings are stale", { exact: true }),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("article", { name: "qwen3-vl:8b-instruct" }),
    ).toBeVisible();
  });
});

test("model links preserve range and selection through refresh and history @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await page.route("**/api/ai/models", (route) =>
    route.fulfill({ json: inventory }),
  );
  await page.route("**/api/ai/models/history", (route) =>
    route.fulfill({ json: { samples: [] } }),
  );
  await frigateApp.goto("/system?model=genai%3Alocal&range=15#models");
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("genai:local");
  await expect(page.getByLabel("History range")).toHaveValue("15");
  await model.selectOption("audio:medium");
  await expect(page).toHaveURL(/model=audio%3Amedium/);
  await page.goBack();
  await expect(model).toHaveValue("genai:local");
  await page.goForward();
  await expect(model).toHaveValue("audio:medium");
  await page.reload();
  await expect(model).toHaveValue("audio:medium");
  await page.getByLabel("Select general").click();
  await expect(page).toHaveURL(/range=15#general/);
  // The data router can update history before React commits the new tab.
  await expect(page.getByLabel("Select general")).toHaveAttribute(
    "data-state",
    "on",
  );
  await page.getByLabel("Select AI Models").click();
  await expect(model).toHaveValue("audio:medium");
});

test("inactive model tabs stop refreshing @medium @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  let requests = 0;
  await page.route("**/api/ai/models", (route) => {
    requests++;
    return route.fulfill({ json: inventory });
  });
  await page.route("**/api/ai/models/history", (route) =>
    route.fulfill({ json: { samples: [] } }),
  );
  await page.clock.install();
  await frigateApp.goto("/system#models");
  await expect(
    page.getByRole("article", { name: "Whisper Medium" }),
  ).toBeVisible();
  const initial = requests;
  await page.clock.fastForward(11000);
  await expect.poll(() => requests).toBeGreaterThan(initial);
  await page.getByLabel("Select general").click();
  await expect(
    page.getByRole("article", { name: "Whisper Medium" }),
  ).toHaveCount(0);
  const before = requests;
  await page.clock.fastForward(31000);
  expect(requests).toBe(before);
});
