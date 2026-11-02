/**
 * Fork: route error boundary (report item C1).
 *
 * The Exports page derives its list with `rawExports.filter(...)`, so a
 * malformed (non-array) `/api/exports` payload throws during render. That
 * is the cheapest deterministic way to force a page-level render error in
 * the production preview build the e2e suite runs against. Chunk-load
 * failures are simulated by aborting the lazy page chunk request.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";
import { BASE_STATS } from "../../fixtures/mock-data/stats";

const MALFORMED_EXPORTS = "**/api/exports**";

test.describe("Route error boundary @high", () => {
  // React reports the caught render error through console.error, and the
  // boundary itself deliberately shows the TypeError message.
  test.use({
    expectedErrors: [
      /is not a function|An error occurred in the|The above error occurred/,
    ],
  });

  test("shows a recovery panel instead of a blank page when a route throws", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route(MALFORMED_EXPORTS, (route) =>
      route.fulfill({ json: { unexpected: true } }),
    );
    await frigateApp.goto("/export");

    const panel = frigateApp.page.getByTestId("fork-error-boundary");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("Something went wrong")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Copy details" }),
    ).toBeVisible();
    await expect(
      panel.getByTestId("fork-error-boundary-message"),
    ).toContainText("is not a function");

    // The panel lives inside the route container, and the chrome boundary
    // did not trip, so the navigation is still usable.
    await expect(
      frigateApp.page.locator("#pageRoot [data-testid='fork-error-boundary']"),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary-chrome"),
    ).toHaveCount(0);
    await expect(frigateApp.page.locator('a[href="/"]').first()).toBeVisible();
  });

  test("copy details writes a report to the clipboard", async ({
    frigateApp,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await frigateApp.page.route(MALFORMED_EXPORTS, (route) =>
      route.fulfill({ json: { unexpected: true } }),
    );
    // the report reads the version from the stats the chrome fetched
    const statsLoaded = frigateApp.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/api/stats"),
    );
    await frigateApp.goto("/export");
    await statsLoaded;

    const panel = frigateApp.page.getByTestId("fork-error-boundary");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.getByRole("button", { name: "Copy details" }).click();
    await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();

    const clipboard = await frigateApp.page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboard).toContain("Frigate UI error report");
    // UI156 (upstream #24255): the version comes first
    expect(clipboard).toContain("Version: 0.15.0-test");
    expect(clipboard).toContain("is not a function");
    expect(clipboard).toContain("/export");
  });

  test("navigating to another route clears the error", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route(MALFORMED_EXPORTS, (route) =>
      route.fulfill({ json: { unexpected: true } }),
    );
    await frigateApp.goto("/export");
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary"),
    ).toBeVisible({ timeout: 10_000 });

    await frigateApp.page.locator('a[href="/"]').first().click();
    await expect(frigateApp.page).toHaveURL(/\/$/);
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary"),
    ).toHaveCount(0);
    await expect(
      frigateApp.page.locator("[data-camera='front_door']"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test(
    "@mobile recovery panel renders inside the mobile layout",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.page.route(MALFORMED_EXPORTS, (route) =>
        route.fulfill({ json: { unexpected: true } }),
      );
      await frigateApp.goto("/export");

      const panel = frigateApp.page.getByTestId("fork-error-boundary");
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByRole("button", { name: "Reload" })).toBeVisible();
      // Bottom bar survives the page failure.
      await expect(
        frigateApp.page.locator('a[href="/review"]').first(),
      ).toBeVisible();
    },
  );
});

test.describe("Route error boundary - chunk load failure @high", () => {
  test.use({
    expectedErrors: [
      /Failed to fetch dynamically imported module|Importing a module script failed|net::ERR_FAILED|An error occurred in the|The above error occurred/,
    ],
  });

  test("suggests a reload when a lazy page chunk fails to load", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route(
      /\/assets\/Exports-[^/]+\.js(\?.*)?$/,
      (route) => route.abort("failed"),
    );
    await frigateApp.goto("/");
    await frigateApp.page.locator('a[href="/export"]').first().click();

    const panel = frigateApp.page.getByTestId("fork-error-boundary");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("Update available")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Reload" })).toBeVisible();
  });
});

/**
 * UI156 (upstream #24255): each piece of chrome has its own boundary, so a
 * throw in one leaves the others, and the page, in place. `useStats` runs
 * `Object.entries(stats.detectors)` and only the status bar and bottom bar
 * call it, so null detectors throw in exactly one chrome component.
 */
async function breakStatsChrome(app: FrigateApp) {
  await app.page.route("**/api/stats", (route) =>
    route.fulfill({ json: { ...BASE_STATS, detectors: null } }),
  );
}

test.describe("Route error boundary - chrome failure @high", () => {
  test.use({
    expectedErrors: [
      /is not a function|Cannot convert undefined or null to object|An error occurred in the|The above error occurred/,
    ],
  });

  test("a thrown status bar leaves the sidebar usable", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "The status bar is desktop chrome");
    await breakStatsChrome(frigateApp);
    await frigateApp.goto("/");

    const strip = frigateApp.page.getByTestId("fork-error-boundary-chrome");
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText("Part of the interface stopped working");
    await expect(strip.getByRole("button", { name: "Reload" })).toBeVisible();

    await expect(frigateApp.page.locator("aside")).toBeVisible();
    await expect(
      frigateApp.page.locator('a[href="/review"]').first(),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary"),
    ).toHaveCount(0);
  });

  test("the strip stays put across navigation without remounting the sidebar", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "The status bar is desktop chrome");
    await breakStatsChrome(frigateApp);
    await frigateApp.goto("/");
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary-chrome"),
    ).toBeVisible({ timeout: 10_000 });

    // The sidebar keeps its DOM node: the reset no longer remounts the tree
    await frigateApp.page
      .locator("aside")
      .evaluate((node) => node.setAttribute("data-ui156", "kept"));
    await frigateApp.page.locator('a[href="/review"]').first().click();
    await expect(frigateApp.page).toHaveURL(/\/review/);
    await expect(frigateApp.page.locator("aside")).toHaveAttribute(
      "data-ui156",
      "kept",
    );
    // the status bar throws again on the new route and is caught again
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary-chrome"),
    ).toHaveCount(1);
  });

  test("a thrown bottom bar keeps the page", async ({ frigateApp }) => {
    test.skip(!frigateApp.isMobile, "The bottom bar is phone chrome");
    await breakStatsChrome(frigateApp);
    await frigateApp.goto("/");

    await expect(
      frigateApp.page.getByTestId("fork-error-boundary-chrome"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      frigateApp.page.getByTestId("fork-error-boundary"),
    ).toHaveCount(0);
    await expect(
      frigateApp.page.locator("[data-camera='front_door']"),
    ).toBeVisible({ timeout: 10_000 });
  });
});
