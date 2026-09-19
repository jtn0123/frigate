/**
 * Fork: third walk over the Settings pages (UI117).
 *
 * The Roles page names roles in its error state, the override badges sit
 * under the section title in one row, the Birdseye objects-mode notice is a
 * warning that links to the setting behind it, and Reindex has its own card.
 */

import { test, expect } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";
import { configFactory } from "../../fixtures/mock-data/config";

test.describe("Roles load error (UI117) @high", () => {
  test.use({ expectedErrors: [/403.*\/api\/users/] });

  test(
    "the Roles page names roles, not users",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await page.route(/\/api\/users(\?|$)/, (route) =>
        route.fulfill({ status: 403, json: { message: "Forbidden" } }),
      );
      await frigateApp.goto("/settings?page=roles");
      await expect(page.getByText("Could not load roles")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Could not load users")).toHaveCount(0);
      await expect(page.getByText(/manage roles/)).toBeVisible();
    },
  );
});

test.describe("Section override badges (UI117) @medium @mobile", () => {
  test("the badge row shows once, under the section title", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    await installSettingsConfigRoutes(page);
    await frigateApp.goto("/settings?page=integrationSemanticSearch");

    const enabled = page.getByRole("switch", {
      name: "Enable semantic search",
    });
    await expect(enabled).toBeVisible({ timeout: 10_000 });
    await enabled.click();

    // one row, not a desktop copy and a phone copy
    const badge = page.getByText("Modified", { exact: true });
    await expect(badge).toHaveCount(1);

    const heading = page
      .getByRole("heading", { name: "Semantic Search" })
      .first();
    const headingBox = await heading.boundingBox();
    const badgeBox = await badge.boundingBox();
    // under the title, not across the page from it
    expect(badgeBox?.y ?? 0).toBeGreaterThan(headingBox?.y ?? 0);
    expect(badgeBox?.x ?? 0).toBeLessThan((headingBox?.x ?? 0) + 200);
  });
});

test.describe("Birdseye objects mode notice (UI117) @high", () => {
  test(
    "the notice is a warning and opens the detect settings",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const page = frigateApp.page;
      await installSettingsConfigRoutes(page);
      await page.route("**/api/config", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              json: configFactory({
                cameras: {
                  front_door: {
                    birdseye: { enabled: true, mode: "objects" },
                    detect: { enabled: false },
                  },
                },
              }),
            })
          : route.fulfill({ json: { success: true } }),
      );
      await frigateApp.goto("/settings?page=cameraBirdseye&camera=front_door");
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "will not appear in Birdseye" });
      await expect(alert).toBeVisible({ timeout: 10_000 });

      await alert.getByRole("link", { name: "Open detect settings" }).click();
      // Settings clears its own query params once it has switched pages
      await expect(
        page.getByRole("heading", { name: "Object Detection" }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );
});

test.describe("Semantic search reindex (UI117) @medium @mobile", () => {
  test("reindex is its own card and confirms before it runs", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    await installSettingsConfigRoutes(page);
    await page.route("**/api/config", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: configFactory({ semantic_search: { enabled: true } }),
          })
        : route.fulfill({ json: { success: true } }),
    );
    await frigateApp.goto("/settings?page=integrationSemanticSearch");
    const card = page.getByTestId("semantic-search-reindex");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Reindex tracked objects");

    await card.getByRole("button", { name: "Reindex Now" }).click();
    await expect(page.getByText("Confirm Reindexing")).toBeVisible();
  });
});
