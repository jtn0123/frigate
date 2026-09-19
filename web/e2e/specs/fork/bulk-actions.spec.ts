/**
 * Fork: bulk actions with undo (UI item 10).
 *
 * Explore gets a selection mode with a Select chip in the top filter row
 * (Delete and Submit to Frigate+); Review's existing multi-select gets an
 * undo toast for Mark as reviewed.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/frigate-test";

const EXPLORE_URL = "/explore?labels=person";

function thumbnails(page: Page) {
  return page.locator('img[src*="/thumbnail.webp"]');
}

async function enterSelectMode(page: Page) {
  const select = page.getByTestId("bulk-select");
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.click();
  await expect(page.getByTestId("bulk-action-bar")).toBeVisible();
}

test.describe("Explore bulk actions @high", () => {
  test("Select is on Explore home without a labels filter", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/explore");
    const { page } = frigateApp;
    const select = page.getByTestId("bulk-select");
    await expect(select).toBeVisible({ timeout: 10_000 });

    if (frigateApp.isMobile) {
      await enterSelectMode(page);
      await thumbnails(page).first().tap();
    } else {
      const selectBox = await select.boundingBox();
      const settingsBox = await page
        .getByRole("button", { name: /settings/i })
        .last()
        .boundingBox();
      expect(
        Math.abs((selectBox?.y ?? 0) - (settingsBox?.y ?? 0)),
      ).toBeLessThan(24);
      await enterSelectMode(page);
      await thumbnails(page).first().click();
    }

    await expect(page.getByTestId("bulk-count")).toHaveText("1 selected");
    await expect(page.locator(".outline-selected")).toHaveCount(1);
  });

  test(
    "Select mode toggles items and Shift-click selects a range",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto(EXPLORE_URL);
      const { page } = frigateApp;
      await expect(thumbnails(page)).toHaveCount(3);

      const select = page.getByTestId("bulk-select");
      await expect(select).toBeVisible({ timeout: 10_000 });
      const selectBox = await select.boundingBox();
      const settingsBox = await page
        .getByRole("button", { name: /settings/i })
        .last()
        .boundingBox();
      expect(selectBox?.y).toBeLessThan(120);
      expect(
        Math.abs((selectBox?.y ?? 0) - (settingsBox?.y ?? 0)),
      ).toBeLessThan(24);

      await enterSelectMode(page);
      await expect(page.getByTestId("bulk-count")).toHaveText("0 selected");
      await expect(
        page.getByRole("button", { name: /settings/i }).last(),
      ).toBeVisible();
      await expect(page.getByText("All Dates", { exact: true })).toBeVisible();
      await expect(page.getByText("Sort", { exact: true })).toBeVisible();
      await expect(
        page.getByText("More Filters", { exact: true }),
      ).toBeVisible();
      await thumbnails(page).nth(0).click();
      await expect(page.getByTestId("bulk-count")).toHaveText("1 selected");
      await expect(page.locator(".outline-selected")).toHaveCount(1);

      await thumbnails(page)
        .nth(2)
        .click({ modifiers: ["Shift"] });
      await expect(page.getByTestId("bulk-count")).toHaveText("3 selected");
      await expect(page.locator(".outline-selected")).toHaveCount(3);

      await thumbnails(page).nth(1).click();
      await expect(page.getByTestId("bulk-count")).toHaveText("2 selected");

      await page.getByTestId("bulk-cancel").click();
      await expect(page.getByTestId("bulk-action-bar")).toBeHidden();
      await expect(page.locator(".outline-selected")).toHaveCount(0);
    },
  );

  test(
    "Delete asks for confirmation and deletes the selection",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const deleted: string[][] = [];
      await page.route("**/api/events/", async (route) => {
        if (route.request().method() === "DELETE") {
          deleted.push(route.request().postDataJSON().event_ids);
          return route.fulfill({ json: { success: true } });
        }
        return route.fallback();
      });
      await frigateApp.goto(EXPLORE_URL);
      await expect(thumbnails(page)).toHaveCount(3);

      await enterSelectMode(page);
      await page.getByTestId("bulk-select-all").click();
      await expect(page.getByTestId("bulk-count")).toHaveText("3 selected");
      await page.getByTestId("bulk-delete").click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.getByTestId("bulk-confirm").click();

      await expect.poll(() => deleted.length).toBe(1);
      expect(deleted[0]).toHaveLength(3);
      await expect(page.getByTestId("bulk-action-bar")).toBeHidden();
    },
  );

  test(
    "Submit to Frigate+ appears when Plus is enabled and posts each snapshot",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.installDefaults({ config: { plus: { enabled: true } } });
      const submitted: string[] = [];
      await page.route("**/api/events/*/plus", async (route) => {
        submitted.push(route.request().url());
        await route.fulfill({ json: { success: true } });
      });
      await frigateApp.goto(EXPLORE_URL);
      await expect(thumbnails(page)).toHaveCount(3);

      await enterSelectMode(page);
      await thumbnails(page).nth(0).click();
      await thumbnails(page).nth(1).click();
      await page.getByTestId("bulk-plus").click();
      await expect(page.getByRole("alertdialog")).toContainText("2 selected");
      await page.getByTestId("bulk-confirm").click();

      await expect.poll(() => submitted.length).toBe(2);
      await expect(
        page.getByText("2 snapshots submitted to Frigate+"),
      ).toBeVisible();
    },
  );

  test(
    "Select button and long-press select items @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto(EXPLORE_URL);
      const { page } = frigateApp;
      await expect(thumbnails(page)).toHaveCount(3);

      await enterSelectMode(page);
      await thumbnails(page).nth(0).tap();
      await expect(page.getByTestId("bulk-count")).toHaveText("1 selected");

      // Chrome on Android reports a long press as a contextmenu event.
      await thumbnails(page).nth(1).dispatchEvent("contextmenu");
      await expect(page.getByTestId("bulk-count")).toHaveText("2 selected", {
        timeout: 3_000,
      });
    },
  );
});

test.describe("Review mark-as-reviewed undo @high", () => {
  test(
    "marking selected items reviewed offers an Undo that reverts",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const viewed: { ids: string[]; reviewed: boolean }[] = [];
      await page.route("**/api/reviews/viewed", async (route) => {
        viewed.push(route.request().postDataJSON());
        await route.fulfill({ json: { success: true } });
      });
      await frigateApp.goto("/review");

      // Default mock data hides the reviewed alert, so only one card is shown
      // until Show Reviewed is on.
      await page.getByRole("switch", { name: /show reviewed/i }).click();
      const items = page.locator(".review-item");
      await expect(items).toHaveCount(2, { timeout: 10_000 });
      await items.nth(0).click({ modifiers: ["Meta"] });
      await items.nth(1).click();
      await expect(page.getByText(/2.*selected/i)).toBeVisible();

      await page.getByRole("button", { name: "Mark as reviewed" }).click();
      await expect(page.getByText("1 item marked as reviewed")).toBeVisible();
      // the alert that was already reviewed is left alone, so Undo cannot
      // unmark it (UI87)
      expect(viewed).toEqual([{ ids: ["review-alert-001"], reviewed: true }]);

      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("Change undone")).toBeVisible();
      expect(viewed.at(1)).toEqual({
        ids: ["review-alert-001"],
        reviewed: false,
      });
    },
  );

  test(
    "marking the whole list with reviewed items shown undoes only the new ones",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const viewed: { ids: string[]; reviewed: boolean }[] = [];
      await page.route("**/api/reviews/viewed", async (route) => {
        viewed.push(route.request().postDataJSON());
        await route.fulfill({ json: { success: true } });
      });
      await frigateApp.goto("/review");
      await page.getByRole("switch", { name: /show reviewed/i }).click();
      await expect(page.locator(".review-item")).toHaveCount(2, {
        timeout: 10_000,
      });

      await page
        .getByRole("button", { name: /Mark \d+ items? as reviewed/ })
        .click();
      await expect(page.getByText("1 item marked as reviewed")).toBeVisible();
      expect(viewed).toEqual([{ ids: ["review-alert-001"], reviewed: true }]);

      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("Change undone")).toBeVisible();
      expect(viewed.at(1)).toEqual({
        ids: ["review-alert-001"],
        reviewed: false,
      });
    },
  );

  test(
    "Undo on a past day shows the items unreviewed again",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const counts = {
        reviewed_alert: 1,
        reviewed_detection: 0,
        total_alert: 2,
        total_detection: 2,
      };
      // the mock reviews are on 2026-06-05; cover the days around it so the
      // browser's time zone does not matter
      await page.route(/\/api\/review\/summary/, (route) =>
        route.fulfill({
          json: Object.fromEntries(
            ["2026-06-04", "2026-06-05", "2026-06-06"].map((day) => [
              day,
              { day, ...counts },
            ]),
          ),
        }),
      );
      await frigateApp.goto("/review");
      // a date range, as the calendar sets it (UI80)
      const reviewStart = 1780677009;
      await page.evaluate(
        ({ after, before }) => {
          const state = history.state ?? {};
          history.replaceState(
            {
              ...state,
              usr: { ...state.usr, reviewFilter: { after, before } },
            },
            "",
          );
        },
        { after: reviewStart - 6 * 3600, before: reviewStart + 3600 },
      );
      await page.reload();

      const items = page.locator(".review-item");
      await expect(items).toHaveCount(1, { timeout: 10_000 });
      await page
        .getByRole("button", { name: /Mark \d+ items? as reviewed/ })
        .click();
      await expect(page.getByText("1 item marked as reviewed")).toBeVisible();
      await expect(items.locator(".bg-green-600")).toHaveCount(1);

      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("Change undone")).toBeVisible();
      // the list is read again, so the item is no longer marked reviewed
      await expect(items.locator(".bg-gray-500")).toHaveCount(1);
      await expect(items.locator(".bg-green-600")).toHaveCount(0);
    },
  );

  test(
    "long-press select then Undo reverts mark-reviewed @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const viewed: { ids: string[]; reviewed: boolean }[] = [];
      await page.route("**/api/reviews/viewed", async (route) => {
        viewed.push(route.request().postDataJSON());
        await route.fulfill({ json: { success: true } });
      });
      await frigateApp.goto("/review");

      const thumb = page.locator(".review-item img").first();
      await expect(thumb).toBeVisible({ timeout: 10_000 });
      // Long-press lives on the thumbnail img, not the card wrapper; Chrome on
      // Android reports it as a contextmenu event.
      await thumb.dispatchEvent("contextmenu");
      await expect(page.getByText("1 selected")).toBeVisible({
        timeout: 3_000,
      });

      await page.getByRole("button", { name: "Mark as reviewed" }).click();
      await expect.poll(() => viewed.length).toBe(1);
      expect(viewed.at(0)).toMatchObject({ reviewed: true });
      expect(viewed.at(0)?.ids).toHaveLength(1);
      await expect(page.getByText("1 item marked as reviewed")).toBeVisible();

      await page.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => viewed.length).toBe(2);
      expect(viewed.at(1)).toEqual({ ids: viewed.at(0)?.ids, reviewed: false });
      await expect(page.getByText("Change undone")).toBeVisible();
    },
  );
});
