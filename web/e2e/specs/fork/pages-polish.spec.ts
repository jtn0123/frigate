/**
 * Fork: third UI walk over the pages outside Settings (UI116).
 *
 * The Review grid's mark-reviewed bar carries its count, Explore rows link
 * out with a labeled link, an empty face library offers Add Face once, the
 * Logs actions go dead while the logs failed to load, camera charts never
 * print "Invalid time", and the Enrichments tab explains itself when it has
 * nothing to draw.
 */

import { test, expect } from "../../fixtures/frigate-test";

test.describe("Review mark-reviewed bar (UI116) @high @mobile", () => {
  test("the bar sits under the grid and counts what it marks", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/review");
    const page = frigateApp.page;
    const bar = page.getByTestId("mark-reviewed-bar");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText("not reviewed");

    const button = bar.getByRole("button");
    await expect(button).toHaveAccessibleName(/Mark \d+ item(s)? as reviewed/);

    // the bar belongs to the grid, not to the middle of the empty space
    const barBox = await bar.boundingBox();
    const card = page
      .locator("[data-testid='mark-reviewed-bar']")
      .locator("..");
    const gridBox = await card.boundingBox();
    expect(barBox?.x ?? 0).toBeLessThanOrEqual((gridBox?.x ?? 0) + 24);
  });
});

test.describe("Explore row link (UI116) @high @mobile", () => {
  test("each summary row links out with a labeled link", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/explore");
    const page = frigateApp.page;
    const link = page.getByTestId("explore-row-view-all").first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    // the label is visible text, not only a tooltip
    await expect(link).toContainText("View all");
    await expect(link).toHaveAccessibleName(/Explore more/i);

    await link.click();
    await expect(page).toHaveURL(/labels=/);
  });
});

test.describe("Face library empty state (UI116) @medium", () => {
  test(
    "an empty library offers Add Face once",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/faces");
      const page = frigateApp.page;
      await expect(page.getByText("Upload a face")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole("button", { name: "Add Face" })).toHaveCount(
        1,
      );
    },
  );
});

test.describe("Logs actions while in error (UI116) @high", () => {
  test.use({ expectedErrors: [/500.*\/api\/logs\/frigate/] });

  test(
    "copy and download go dead and the column headers step aside",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await page.route(/\/api\/logs\/frigate(\?|$)/, (route) =>
        route.fulfill({ status: 500, json: { success: false } }),
      );
      await frigateApp.goto("/logs");
      await expect(page.getByTestId("fork-error-state")).toBeVisible({
        timeout: 10_000,
      });

      await expect(
        page.getByRole("button", { name: "Copy to Clipboard" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Download" }),
      ).toBeDisabled();
      await expect(page.getByText("Timestamp", { exact: true })).toBeHidden();
    },
  );
});

test.describe("Camera chart axis labels (UI116) @high @mobile", () => {
  test("no chart prints Invalid time", async ({ frigateApp }) => {
    const page = frigateApp.page;
    await frigateApp.goto("/system#cameras");
    await expect(page.getByText("Frames / Detections").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Invalid time")).toHaveCount(0);
  });
});

test.describe("Enrichments tab with no stats (UI116) @medium @mobile", () => {
  test("the empty tab says why and links to the settings", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    // the tab only exists once an enrichment feature is on, and the fixture
    // stats carry no embeddings section, which is the case this covers
    await frigateApp.installDefaults({
      config: { semantic_search: { enabled: true } },
    });
    await frigateApp.goto("/system#enrichments");
    const empty = page.getByTestId("enrichments-empty-state");
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await expect(empty).toContainText("No enrichment activity yet");

    await empty.getByRole("button").click();
    await expect(page).toHaveURL(/page=integrationSemanticSearch/);
  });
});
