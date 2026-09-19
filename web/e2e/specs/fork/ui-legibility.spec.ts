/**
 * Fork: legibility and layout fixes found in the second UI walk (UI101).
 *
 * Toasts clear a pushed page's header on a phone, warning text is readable in
 * dark mode, the status bar gives a long message the room it has, the region
 * grid has a fallback, and Save sits under the settings form.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";
import { openStatusIssues } from "../../helpers/status-issues";

async function useDarkTheme(frigateApp: FrigateApp) {
  await frigateApp.page.addInitScript(() =>
    localStorage.setItem(
      "frigate-ui-theme",
      JSON.stringify({ theme: "dark", colorScheme: "theme-default" }),
    ),
  );
}

test.describe("UI legibility @medium", () => {
  test("the region grid shows a message when there is no image", async ({
    frigateApp,
  }) => {
    await frigateApp.page.route("**/api/*/grid.jpg*", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    await frigateApp.goto("/settings?page=regionGrid");
    await expect(
      frigateApp.page.getByText(
        "No region grid is available for this camera yet.",
      ),
    ).toBeVisible();
  });

  test(
    "a toast leaves the back button uncovered on a phone @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/settings?page=regionGrid");
      await page.getByRole("button", { name: "Clear region grid" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: /clear/i })
        .click();
      const toast = page.locator("[data-sonner-toast]").first();
      await expect(toast).toBeVisible();
      const back = await page
        .getByRole("button", { name: "Go back" })
        .boundingBox();
      await expect
        .poll(async () => (await toast.boundingBox())?.y ?? 0)
        .toBeGreaterThanOrEqual((back?.y ?? 0) + (back?.height ?? 0));
    },
  );

  test(
    "the alert count is readable on the dark selected tab @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await useDarkTheme(frigateApp);
      await frigateApp.goto("/review");
      const count = frigateApp.page
        .getByRole("radio", { name: "Alerts" })
        .locator("div")
        .first();
      await expect(count).toHaveCSS("color", "rgb(248, 113, 113)");
    },
  );

  test(
    "status bar warnings are amber, not brown, in dark mode",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await useDarkTheme(frigateApp);
      await frigateApp.goto("/");
      // UI110: the warnings are listed behind the status bar's chip
      const list = await openStatusIssues(frigateApp.page);
      const icon = list
        .getByRole("listitem")
        .filter({ hasText: /Host collector is missing/ })
        .locator("svg")
        .first();
      await expect(icon).toHaveCSS("color", "rgb(255, 193, 122)");
    },
  );

  test(
    "a long status message fits at 1280 px",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.page.setViewportSize({ width: 1280, height: 720 });
      await frigateApp.goto("/");
      // UI110: the message is read in full in the chip's list, not cut
      const list = await openStatusIssues(frigateApp.page);
      const message = list.getByText(/Host collector is missing/);
      await expect(message).toContainText("measure both containers.");
      const box = await message.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1280);
    },
  );

  test(
    "Save sits under the settings form, not at the far edge",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await installSettingsConfigRoutes(frigateApp.page);
      await frigateApp.goto("/settings?page=cameraBirdseye");
      const save = frigateApp.page.getByRole("button", {
        name: "Save",
        exact: true,
      });
      await expect(save).toBeVisible();
      const form = await frigateApp.page.locator(".config-form").boundingBox();
      const box = await save.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        (form?.x ?? 0) + (form?.width ?? 0) + 1,
      );
    },
  );
});
