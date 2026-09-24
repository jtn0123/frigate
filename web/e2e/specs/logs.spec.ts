/**
 * Logs page tests -- MEDIUM tier.
 *
 * Service tabs (with real /logs/<service> JSON contract),
 * log content render, Copy (clipboard), Download (assert
 * ?download=true request fired), mobile tab selector.
 */

import { test, expect } from "../fixtures/frigate-test";
import { grantClipboardPermissions, readClipboard } from "../helpers/clipboard";

function logsJsonBody(lines: string[]) {
  return { lines, totalLines: lines.length };
}

test.describe("Logs — service tabs @medium", () => {
  test("frigate tab renders by default with mocked log lines", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({
        json: logsJsonBody([
          "[2026-04-06 10:00:00] INFO: Frigate started",
          "[2026-04-06 10:00:01] INFO: Cameras loaded",
        ]),
      }),
    );
    // Silence the streaming fetch so it doesn't hang the test.
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await frigateApp.goto("/logs");
    await expect(frigateApp.page.getByLabel("Select frigate")).toBeVisible({
      timeout: 5_000,
    });
    await expect(frigateApp.page.getByText(/Frigate started/)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("switching to go2rtc fires a GET to /logs/go2rtc", async ({
    frigateApp,
  }) => {
    let go2rtcCalled = false;
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({ json: logsJsonBody(["frigate line"]) }),
    );
    await frigateApp.page.route(/\/api\/logs\/go2rtc(\?|$)/, (route) => {
      if (!route.request().url().includes("stream=true")) {
        go2rtcCalled = true;
      }
      return route.fulfill({ json: logsJsonBody(["go2rtc line"]) });
    });
    await frigateApp.page.route(/\/api\/logs\/.*\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );

    await frigateApp.goto("/logs");
    await expect(frigateApp.page.getByLabel("Select frigate")).toBeVisible({
      timeout: 5_000,
    });
    const go2rtcTab = frigateApp.page.getByLabel("Select go2rtc");
    await expect(go2rtcTab).toBeVisible();
    await go2rtcTab.click();
    await expect.poll(() => go2rtcCalled, { timeout: 5_000 }).toBe(true);
    await expect(go2rtcTab).toHaveAttribute("data-state", "on");
  });
});

test.describe("Logs — actions @medium", () => {
  test("Copy button writes current logs to clipboard", async ({
    frigateApp,
    context,
  }) => {
    await grantClipboardPermissions(context);
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({
        json: logsJsonBody([
          "[2026-04-06 10:00:00] INFO: Frigate started",
          "[2026-04-06 10:00:01] INFO: Cameras loaded",
        ]),
      }),
    );
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await frigateApp.goto("/logs");
    await expect(frigateApp.page.getByText(/Frigate started/)).toBeVisible({
      timeout: 10_000,
    });

    const copyBtn = frigateApp.page.getByLabel("Copy to Clipboard");
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    await copyBtn.click();
    await expect
      .poll(() => readClipboard(frigateApp.page), { timeout: 5_000 })
      .toContain("Frigate started");
  });

  test("Download button fires GET /logs/<service>?download=true", async ({
    frigateApp,
  }) => {
    let downloadCalled = false;
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
      if (route.request().url().includes("download=true")) {
        downloadCalled = true;
      }
      return route.fulfill({ json: logsJsonBody(["frigate line"]) });
    });
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );

    await frigateApp.goto("/logs");
    const downloadBtn = frigateApp.page.getByLabel("Download Logs");
    await expect(downloadBtn).toBeVisible({ timeout: 5_000 });
    await downloadBtn.click();
    await expect.poll(() => downloadCalled, { timeout: 5_000 }).toBe(true);
  });
});

test.describe("Logs — websocket tab @medium", () => {
  test("switching to websocket tab renders WsMessageFeed container", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({ json: logsJsonBody(["frigate line"]) }),
    );
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await frigateApp.goto("/logs");
    // named after its visible label since UI50 (it used the raw id)
    const wsTab = frigateApp.page.getByRole("radio", {
      name: "Select Messages",
      exact: true,
    });
    await expect(wsTab).toBeVisible({ timeout: 5_000 });
    await wsTab.click();
    await expect(wsTab).toHaveAttribute("data-state", "on", { timeout: 5_000 });
  });
});

test.describe("Logs — streaming @medium", () => {
  test("streamed log lines appear in the viewport", async ({ frigateApp }) => {
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
      if (route.request().url().includes("stream=true")) {
        // Intercepted below via addInitScript fetch override.
        return route.fallback();
      }
      return route.fulfill({
        json: logsJsonBody(["[2026-04-06 10:00:00] INFO: initial batch line"]),
      });
    });

    // Override window.fetch so the /api/logs/frigate?stream=true request
    // resolves with a real ReadableStream that emits chunks over time.
    // This is the only way to validate streaming-append behavior through
    // Playwright — route.fulfill() cannot return a stream.
    // NOTE: The app calls fetch('api/logs/...') with a relative URL (no
    // leading slash), so we match both relative and absolute forms.
    await frigateApp.page.addInitScript(() => {
      const origFetch = window.fetch;
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        if (url.includes("api/logs/frigate") && url.includes("stream=true")) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              await new Promise((r) => setTimeout(r, 30));
              controller.enqueue(
                encoder.encode(
                  "[2026-04-06 10:00:02] INFO: streamed line one\n",
                ),
              );
              await new Promise((r) => setTimeout(r, 30));
              controller.enqueue(
                encoder.encode(
                  "[2026-04-06 10:00:03] INFO: streamed line two\n",
                ),
              );
              controller.close();
            },
          });
          return new Response(stream, { status: 200 });
        }
        return origFetch.call(window, input as RequestInfo, init);
      };
    });

    await frigateApp.goto("/logs");
    // The initial batch line is parsed by LogLineData and its content is
    // rendered in a .log-content cell — assert against that element.
    await expect(frigateApp.page.getByText("initial batch line")).toBeVisible({
      timeout: 10_000,
    });
    await expect(frigateApp.page.getByText(/streamed line one/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(frigateApp.page.getByText(/streamed line two/)).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("Logs — history @medium", () => {
  test("scrolling to the top fetches the previous page of lines", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Wheel scrolling is desktop-only");
    // The newest 100 of 1000 lines load first; scrolling up must request the
    // range that ends where they begin (Logs.tsx loadOlderLines, run when the
    // virtua list's scroll offset is within one viewport of the top).
    const ranges: string[] = [];
    const newest = Array.from(
      { length: 100 },
      (_, i) => `[2026-04-06 10:00:00] INFO: newest line ${900 + i}`,
    );
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("stream") === "true") {
        return route.fulfill({ status: 200, body: "" });
      }
      const end = url.searchParams.get("end");
      if (end === null) {
        return route.fulfill({ json: { lines: newest, totalLines: 1000 } });
      }
      const start = Number(url.searchParams.get("start"));
      ranges.push(`${start}-${end}`);
      const older = Array.from(
        { length: Number(end) - start },
        (_, i) => `[2026-04-06 09:00:00] INFO: older line ${start + i}`,
      );
      return route.fulfill({ json: { lines: older, totalLines: 1000 } });
    });

    await frigateApp.goto("/logs");
    await expect(frigateApp.page.getByText("newest line 999")).toBeVisible({
      timeout: 10_000,
    });
    await frigateApp.page.getByText("newest line 999").hover();
    await expect(async () => {
      await frigateApp.page.mouse.wheel(0, -20_000);
      expect(ranges[0]).toMatch(/^\d+-900$/);
    }).toPass({ timeout: 10_000 });

    const start = Number(ranges[0].split("-")[0]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(900);
  });
});

test.describe("Logs — mobile @medium @mobile", () => {
  test.skip(({ frigateApp }) => !frigateApp.isMobile, "Mobile-only");

  test("service tabs render at mobile viewport", async ({ frigateApp }) => {
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({ json: logsJsonBody(["frigate line"]) }),
    );
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await frigateApp.goto("/logs");
    await expect(frigateApp.page.getByLabel("Select frigate")).toBeVisible({
      timeout: 5_000,
    });
  });
});

test.describe("Logs — load errors and tab labels (UI50) @medium @mobile", () => {
  test("a malformed log response shows an error state, not a raw error", async ({
    frigateApp,
  }) => {
    let healthy = false;
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      healthy
        ? route.fulfill({
            json: {
              totalLines: 1,
              lines: ["[2026-04-06 10:00:00] INFO: Frigate started"],
            },
          })
        : route.fulfill({
            contentType: "text/html",
            body: "<html>proxy error</html>",
          }),
    );
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ contentType: "text/plain", body: "" }),
    );
    await frigateApp.goto("/logs");

    const errorState = frigateApp.page.getByTestId("fork-error-state");
    await expect(errorState).toBeVisible({ timeout: 10_000 });
    await expect(
      frigateApp.page.getByText(/Cannot read properties/),
    ).toHaveCount(0);

    healthy = true;
    await errorState.getByRole("button", { name: "Retry" }).click();
    await expect(frigateApp.page.getByText(/Frigate started/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(errorState).toHaveCount(0);
  });

  test("log sources keep their real names", async ({ frigateApp }) => {
    await frigateApp.page.route(/\/api\/logs\/.*/, (route) =>
      route.fulfill({ json: { totalLines: 0, lines: [] } }),
    );
    await frigateApp.goto("/logs");
    const go2rtc = frigateApp.page.getByRole("radio", {
      name: "Select go2rtc",
      exact: true,
    });
    await expect(go2rtc).toBeVisible({ timeout: 10_000 });
    // innerText: the old label was "go2rtc" in the DOM, title-cased by CSS
    await expect(go2rtc).toHaveText("go2rtc", { useInnerText: true });
    await expect(
      frigateApp.page.getByRole("radio", { name: "Select nginx", exact: true }),
    ).toHaveText("nginx", { useInnerText: true });
  });

  test(
    "@mobile the last log tab is reachable beside the action buttons",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.page.route(/\/api\/logs\/.*/, (route) =>
        route.fulfill({ json: { totalLines: 0, lines: [] } }),
      );
      await frigateApp.goto("/logs");
      const messages = frigateApp.page.getByRole("radio", {
        name: "Select Messages",
        exact: true,
      });
      await expect(messages).toBeVisible({ timeout: 10_000 });
      // click() fails if another element (the Copy button) would take it
      await messages.click();
      await expect(messages).toHaveAttribute("data-state", "on");
    },
  );
});

test.describe("Logs: severity filter history (UI82) @medium", () => {
  test(
    "a severity filter does not fetch lines already on screen",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const lines = Array.from(
        { length: 200 },
        (_, i) =>
          `[2026-04-06 10:00:00] frigate.app ${i % 2 ? "WARNING" : "INFO"} : line ${i}`,
      );
      const ranges: string[] = [];
      await page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("stream") === "true") {
          return route.fulfill({ status: 200, body: "" });
        }
        const start = Number(url.searchParams.get("start"));
        const end = url.searchParams.get("end");
        if (end !== null) ranges.push(`${start}-${end}`);
        const slice =
          end === null ? lines.slice(start) : lines.slice(start, Number(end));
        return route.fulfill({
          json: { lines: slice, totalLines: lines.length },
        });
      });

      await frigateApp.goto("/logs");
      await expect(page.getByText("line 199", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      // Use the visible tail row. Clicking the first warning scrolls upward
      // and can request older history before the severity filter is applied.
      // exact: each log row is a button whose name includes its severity
      await page
        .getByRole("button", { name: "Warning", exact: true })
        .last()
        .click();
      // the filtered read starts at the first line and keeps only warnings
      await expect(page.getByText("line 198", { exact: true })).toHaveCount(0);

      await page.getByText("line 199", { exact: true }).hover();
      await expect(async () => {
        await page.mouse.wheel(0, -20_000);
        await expect(page.getByText("line 1", { exact: true })).toBeVisible({
          timeout: 1_000,
        });
      }).toPass({ timeout: 10_000 });
      // give the scroll handler time to run: every line is already on
      // screen, so it must not ask for more
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(ranges).toEqual([]);
    },
  );
});

test.describe("Logs: history reads (UI84) @medium", () => {
  test(
    "a slow history read is not requested twice",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const ranges: string[] = [];
      const newest = Array.from(
        { length: 100 },
        (_, i) => `[2026-04-06 10:00:00] INFO: newest line ${900 + i}`,
      );
      await page.route(/\/api\/logs\/frigate(\?|$)/, async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("stream") === "true") {
          return route.fulfill({ status: 200, body: "" });
        }
        const end = url.searchParams.get("end");
        if (end === null) {
          return route.fulfill({ json: { lines: newest, totalLines: 1000 } });
        }
        const start = Number(url.searchParams.get("start"));
        ranges.push(`${start}-${end}`);
        // slow enough that the user keeps scrolling while it is in flight
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return route.fulfill({
          json: {
            lines: Array.from(
              { length: 5 },
              (_, i) => `[2026-04-06 09:00:00] INFO: older line ${start + i}`,
            ),
            totalLines: 1000,
          },
        });
      });

      await frigateApp.goto("/logs");
      await expect(page.getByText("newest line 999")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByText("newest line 999").hover();
      await page.mouse.wheel(0, -20_000);
      // keep nudging the list at the top until a second read goes out
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, 200);
            await page.mouse.wheel(0, -400);
            return ranges.length;
          },
          { intervals: [150], timeout: 15_000 },
        )
        .toBeGreaterThan(1);
      // the second read waited for the first and asked for the next range
      expect(new Set(ranges).size).toBe(ranges.length);
    },
  );
});

test.describe("Logs: copy reads the log (UI83) @medium @mobile", () => {
  test.use({ expectedErrors: [/500.*\/api\/logs\/frigate/] });

  /** Serves the n-th log read from `reads`; null answers with a 500. */
  async function routeLogReads(
    page: import("@playwright/test").Page,
    reads: (n: number) => string[] | null,
  ) {
    let count = 0;
    await page.route(/\/api\/logs\/frigate(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("stream") === "true") {
        return route.fulfill({ status: 200, body: "" });
      }
      const lines = reads(count++);
      if (lines === null) {
        return route.fulfill({ status: 500, json: { success: false } });
      }
      return route.fulfill({ json: logsJsonBody(lines) });
    });
  }

  test("Copy copies the log as it is now", async ({ frigateApp, context }) => {
    const { page } = frigateApp;
    await grantClipboardPermissions(context);
    await routeLogReads(page, (n) =>
      n === 0
        ? ["[2026-04-06 10:00:00] INFO: Frigate started"]
        : [
            "[2026-04-06 10:00:00] INFO: Frigate started",
            "[2026-04-06 10:05:00] INFO: Newer line",
          ],
    );
    await frigateApp.goto("/logs");
    await expect(page.getByText(/Frigate started/)).toBeVisible({
      timeout: 10_000,
    });

    await page.getByLabel("Copy to Clipboard").click();
    await expect(page.getByText("Copied logs to clipboard")).toBeVisible();
    expect(await readClipboard(page)).toContain("Newer line");
  });

  test("a failed copy keeps the log on screen", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await routeLogReads(page, (n) =>
      n === 0 ? ["[2026-04-06 10:00:00] INFO: Frigate started"] : null,
    );
    await frigateApp.goto("/logs");
    await expect(page.getByText(/Frigate started/)).toBeVisible({
      timeout: 10_000,
    });

    await page.getByLabel("Copy to Clipboard").click();
    await expect(
      page.getByText("Could not copy logs to clipboard"),
    ).toBeVisible();
    await expect(page.getByText(/Frigate started/)).toBeVisible();
    await expect(page.getByTestId("fork-error-state")).toHaveCount(0);
  });
});
