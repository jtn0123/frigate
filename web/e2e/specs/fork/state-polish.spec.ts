/**
 * Fork: empty, in-progress, error and warning states (UI107 to UI110).
 *
 * System metric cards keep their height and say they are waiting when there
 * is no sample, an in-progress export is legible and shows its progress, the
 * Logs error state is set in the UI font, and the status bar's warnings sit
 * behind one chip.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";
import { BASE_STATS } from "../../fixtures/mock-data/stats";
import { openStatusIssues } from "../../helpers/status-issues";

async function useDarkTheme(frigateApp: FrigateApp) {
  await frigateApp.page.addInitScript(() =>
    localStorage.setItem(
      "frigate-ui-theme",
      JSON.stringify({ theme: "dark", colorScheme: "theme-default" }),
    ),
  );
}

test.describe("System metric cards without samples (UI107) @medium @mobile", () => {
  test("a card with no samples keeps its height and says it is waiting", async ({
    frigateApp,
  }) => {
    // the fixture stats give these cards no samples to draw
    await frigateApp.goto("/system#general");
    const page = frigateApp.page;
    const waiting = page.getByTestId("metric-empty-state");
    await expect(waiting.first()).toBeVisible({ timeout: 10_000 });
    // UI124: the card names the series it waits on and how stale it is
    await expect(waiting.first()).toContainText("Waiting for the first sample");
    await expect(waiting.first()).toContainText("Stats last updated");

    const card = page
      .getByText("Process CPU Usage", { exact: true })
      .locator("..");
    await expect(card.getByTestId("metric-empty-state")).toBeVisible();
    const box = await card.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(170);
  });

  test("a card with samples draws its graph instead", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route("**/api/stats/history**", (route) =>
      route.fulfill({
        json: [1, 2].map((n) => ({
          ...BASE_STATS,
          processes: { go2rtc: { cpu: `${n}.0`, mem: "1.0", pid: 300 } },
          service: {
            ...BASE_STATS.service,
            last_updated: Date.now() / 1000 - 10 + n,
          },
        })),
      }),
    );
    await frigateApp.goto("/system#general");
    const card = frigateApp.page
      .getByText("Process CPU Usage", { exact: true })
      .locator("..");
    await expect(card.getByText("go2rtc", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(card.getByTestId("metric-empty-state")).toHaveCount(0);
  });
  test("an empty history fills from live stats on a fresh start", async ({
    frigateApp,
  }) => {
    // right after a restart the backend has no history yet
    await frigateApp.page.route("**/api/stats/history**", (route) =>
      route.fulfill({ json: [] }),
    );
    await frigateApp.goto("/system#general");
    const card = frigateApp.page
      .getByText("Process CPU Usage", { exact: true })
      .locator("..");
    // resend: a push that lands before the connect frame is overwritten
    await expect(async () => {
      frigateApp.ws.send(
        "stats",
        JSON.stringify({
          ...BASE_STATS,
          processes: { go2rtc: { cpu: "3.0", mem: "1.0", pid: 300 } },
          service: { ...BASE_STATS.service, last_updated: Date.now() / 1000 },
        }),
      );
      await expect(card.getByText("go2rtc", { exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
  });
});

test.describe("In-progress export card (UI108) @medium @mobile", () => {
  test("an in-progress export is legible and says it is exporting", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/export");
    const card = frigateApp.page
      .getByTestId("export-progress-card")
      .filter({ hasText: "Garage - In Progress" });
    await expect(card).toBeVisible();
    await expect(card.getByText("Exporting")).toBeVisible();
    await expect(card.getByRole("progressbar")).toBeVisible();
    // the old card drew white text on a light gray skeleton
    await expect(card.getByText("Garage - In Progress")).not.toHaveCSS(
      "color",
      "rgb(255, 255, 255)",
    );
  });

  test("the title stays readable in dark mode", async ({ frigateApp }) => {
    await useDarkTheme(frigateApp);
    await frigateApp.goto("/export");
    const title = frigateApp.page
      .getByTestId("export-progress-card")
      .getByText("Garage - In Progress");
    await expect(title).toBeVisible();
    const [color, background] = await title.evaluate((el) => {
      const card = el.closest("[data-testid=export-progress-card]");
      return [
        getComputedStyle(el).color,
        card ? getComputedStyle(card).backgroundColor : "",
      ];
    });
    expect(color).not.toBe(background);
    expect(color).not.toBe("rgb(0, 0, 0)");
  });

  test("an export job shows its percent on the same card", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route("**/api/jobs/export", (route) =>
      route.fulfill({
        json: [
          {
            id: "job-encoding",
            job_type: "export",
            status: "running",
            camera: "front_door",
            name: "Encoding Sample",
            export_case_id: null,
            request_start_time: 1775407931,
            request_end_time: 1775408531,
            start_time: 1775407932,
            end_time: null,
            error_message: null,
            results: null,
            current_step: "encoding",
            progress_percent: 42,
          },
        ],
      }),
    );
    await frigateApp.goto("/export");
    const card = frigateApp.page
      .getByTestId("export-progress-card")
      .filter({ hasText: "Encoding Sample" });
    await expect(card.getByText("Exporting")).toBeVisible();
    await expect(card.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });
});

test.describe("Logs error state font (UI109) @medium @mobile", () => {
  test.use({ expectedErrors: [/500.*\/api\/logs\/frigate/] });

  test("the error state uses the UI font", async ({ frigateApp }) => {
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({ status: 500, json: { success: false } }),
    );
    await frigateApp.goto("/logs");
    const state = frigateApp.page.getByTestId("fork-error-state");
    await expect(state).toBeVisible({ timeout: 10_000 });
    const font = (locator: ReturnType<typeof frigateApp.page.getByText>) =>
      locator.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(await font(state.getByText("Could not load this data"))).toMatch(
      /Inter/,
    );
    expect(await font(state.getByRole("button", { name: "Retry" }))).toMatch(
      /Inter/,
    );
  });
});

test.describe("Log column header font (UI109) @medium @mobile", () => {
  // the header only shows once the logs load; UI116 hides it in the error
  // state, where there is nothing for it to label
  test("the log header stays monospace", async ({ frigateApp }) => {
    await frigateApp.page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
      route.fulfill({
        json: {
          lines: ["[2026-04-06 10:00:00] INFO: Frigate started"],
          totalLines: 1,
        },
      }),
    );
    await frigateApp.page.route(/\/api\/logs\/frigate\?stream=true/, (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await frigateApp.goto("/logs");
    const header = frigateApp.page.getByText("Timestamp", { exact: true });
    await expect(header).toBeVisible({ timeout: 10_000 });
    expect(
      await header.evaluate((el) => getComputedStyle(el).fontFamily),
    ).toMatch(/monospace|Menlo|SFMono/);
  });
});

test.describe("Status bar warning chip (UI110) @high", () => {
  test(
    "the warnings collapse to a counted chip that lists them",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await frigateApp.goto("/");
      const chip = page.getByTestId("status-issues-chip");
      await expect(chip).toHaveText(/^\d+ issues?$/, { timeout: 10_000 });
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      // the sentence is no longer printed in the bar
      await expect(page.getByText(/Host collector is missing/)).toHaveCount(0);

      const list = await openStatusIssues(page);
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(list).toContainText(
        "Host collector is missing or stale. Install or check the read-only Proxmox collector to measure both containers.",
      );

      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(chip).toBeFocused();
    },
  );

  test(
    "back closes the list without leaving the page",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await frigateApp.goto("/review");
      const list = await openStatusIssues(page);
      await page.goBack();
      await expect(list).toBeHidden();
      await expect(page).toHaveURL(/\/review$/);
    },
  );

  test(
    "a message links to the page that explains it",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await frigateApp.goto("/");
      const list = await openStatusIssues(page);
      const item = list
        .getByRole("listitem")
        .filter({ hasText: /Host collector is missing/ });
      await item.getByRole("link", { name: "View details" }).click();
      await expect(page).toHaveURL(/\/system#models$/);
      await expect(list).toBeHidden();
    },
  );

  test(
    "the narrow-window status control and its list fit a 412 px window",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await page.setViewportSize({ width: 412, height: 915 });
      await frigateApp.goto("/");
      const trigger = page.getByTestId("status-alert-trigger");
      await trigger.click();
      const list = page.getByTestId("status-message-list");
      await expect(list).toBeVisible();
      for (const locator of [trigger, list]) {
        const box = await locator.boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(412);
      }
    },
  );
});
