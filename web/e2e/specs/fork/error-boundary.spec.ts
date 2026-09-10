/**
 * Fork: route error boundary (report item C1).
 *
 * The Exports page derives its list with `rawExports.filter(...)`, so a
 * malformed (non-array) `/api/exports` payload throws during render. That
 * is the cheapest deterministic way to force a page-level render error in
 * the production preview build the e2e suite runs against. Chunk-load
 * failures are simulated by aborting the lazy page chunk request.
 */

import { test, expect } from "../../fixtures/frigate-test";

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
    await frigateApp.goto("/export");

    const panel = frigateApp.page.getByTestId("fork-error-boundary");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.getByRole("button", { name: "Copy details" }).click();
    await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();

    const clipboard = await frigateApp.page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboard).toContain("Frigate UI error report");
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

  test("@mobile recovery panel renders inside the mobile layout", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile-only assertion");
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
  });
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
