/**
 * Fork: bulk actions with undo (UI item 10).
 *
 * Explore gets a selection mode with a floating action bar (Delete and
 * Submit to Frigate+); Review's existing multi-select gets an undo toast
 * for Mark as reviewed.
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
  test("Select mode toggles items and Shift-click selects a range", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop pointer flow");
    await frigateApp.goto(EXPLORE_URL);
    const { page } = frigateApp;
    await expect(thumbnails(page)).toHaveCount(3);

    await enterSelectMode(page);
    await expect(page.getByTestId("bulk-count")).toHaveText("0 selected");
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
  });

  test("Delete asks for confirmation and deletes the selection", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop pointer flow");
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
  });

  test("Submit to Frigate+ appears when Plus is enabled and posts each snapshot", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop pointer flow");
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
  });

  test("Select button and long-press select items @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile touch flow");
    await frigateApp.goto(EXPLORE_URL);
    const { page } = frigateApp;
    await expect(thumbnails(page)).toHaveCount(3);

    await enterSelectMode(page);
    await thumbnails(page).nth(0).tap();
    await expect(page.getByTestId("bulk-count")).toHaveText("1 selected");

    // The iOS long-press path selects after the touch is held for 610ms.
    await thumbnails(page).nth(1).dispatchEvent("touchstart");
    await expect(page.getByTestId("bulk-count")).toHaveText("2 selected", {
      timeout: 3_000,
    });
    await thumbnails(page).nth(1).dispatchEvent("touchend");
  });
});

test.describe("Review mark-as-reviewed undo @high", () => {
  test("marking selected items reviewed offers an Undo that reverts", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop multi-select flow");
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
    await expect.poll(() => viewed.length).toBe(1);
    expect(viewed[0]).toMatchObject({ reviewed: true });
    expect(viewed[0].ids).toHaveLength(2);
    await expect(page.getByText("2 items marked as reviewed")).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => viewed.length).toBe(2);
    expect(viewed[1]).toEqual({ ids: viewed[0].ids, reviewed: false });
    await expect(page.getByText("Change undone")).toBeVisible();
  });

  test("long-press select then Undo reverts mark-reviewed @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile long-press flow");
    const { page } = frigateApp;
    const viewed: { ids: string[]; reviewed: boolean }[] = [];
    await page.route("**/api/reviews/viewed", async (route) => {
      viewed.push(route.request().postDataJSON());
      await route.fulfill({ json: { success: true } });
    });
    await frigateApp.goto("/review");

    const thumb = page.locator(".review-item img").first();
    await expect(thumb).toBeVisible({ timeout: 10_000 });
    // iOS long-press lives on the thumbnail img, not the card wrapper.
    await thumb.dispatchEvent("touchstart");
    await expect(page.getByText("1 selected")).toBeVisible({ timeout: 3_000 });
    await thumb.dispatchEvent("touchend");

    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    await expect.poll(() => viewed.length).toBe(1);
    expect(viewed[0]).toMatchObject({ reviewed: true });
    expect(viewed[0].ids).toHaveLength(1);
    await expect(page.getByText("1 item marked as reviewed")).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => viewed.length).toBe(2);
    expect(viewed[1]).toEqual({ ids: viewed[0].ids, reviewed: false });
    await expect(page.getByText("Change undone")).toBeVisible();
  });
});
