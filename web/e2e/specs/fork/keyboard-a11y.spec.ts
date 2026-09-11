/**
 * Keyboard accessibility (fork item C2).
 *
 * Covers the three surfaces that used to be mouse-only: the sidebar
 * navigation, the review card grid, and the live camera context menu.
 * Everything here drives the UI with the keyboard only.
 */

import { test, expect } from "../../fixtures/frigate-test";
import { LivePage } from "../../pages/live.page";

/** Press Tab until the predicate holds for document.activeElement. */
async function tabUntil(
  page: import("@playwright/test").Page,
  predicate: string,
  maxPresses = 30,
) {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    const done = await page.evaluate(
      (fn) => new Function("el", `return (${fn})(el)`)(document.activeElement),
      predicate,
    );
    if (done) return;
  }
  throw new Error(`No element matching ${predicate} received focus`);
}

test.describe("Keyboard access: sidebar @critical", () => {
  test.skip(({ frigateApp }) => frigateApp.isMobile, "Sidebar is desktop-only");

  test("nav links are single Tab stops with accessible names", async ({
    frigateApp,
  }) => {
    // /review has no camera-group buttons between the sidebar links.
    await frigateApp.goto("/review");
    const page = frigateApp.page;
    const links = page.locator("aside a[href]");
    await expect(links.first()).toBeVisible({ timeout: 10_000 });

    await tabUntil(
      page,
      'el => el instanceof HTMLAnchorElement && el.closest("aside") !== null',
    );
    const focusedIndex = () =>
      links.evaluateAll((els) =>
        els.indexOf(document.activeElement as HTMLElement),
      );
    const first = await focusedIndex();
    expect(first).toBeGreaterThanOrEqual(0);

    // The next Tab must land on the next sidebar link, not on a tooltip
    // wrapper button around the same link.
    await page.keyboard.press("Tab");
    await expect(page.locator("aside a[href]:focus")).toHaveCount(1);
    expect(await focusedIndex()).toBe(first + 1);

    // Every icon-only nav link must expose a name to screen readers.
    const reviewLink = page.locator('aside a[href="/review"]');
    await expect(reviewLink).toHaveAttribute("aria-label", /.+/);
  });

  test("Enter on a focused nav link navigates", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    const page = frigateApp.page;
    const reviewLink = page.locator('aside a[href="/review"]');
    await expect(reviewLink).toBeVisible({ timeout: 10_000 });
    await reviewLink.focus();
    await expect(reviewLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/review/);
  });
});

test.describe("Keyboard access: review cards @critical", () => {
  test("cards are focusable and Enter opens the recording", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/review");
    const page = frigateApp.page;
    const cards = page.locator('.review-item [role="button"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    await cards.first().focus();
    await expect(cards.first()).toBeFocused();

    // The card sits in the Tab order in both directions.
    await page.keyboard.press("Tab");
    await expect(cards.first()).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cards.first()).toBeFocused();

    await page.keyboard.press("Enter");
    // The recording view is routed through router state, so assert on the
    // document title rather than the URL.
    await expect(page).toHaveTitle(/Recordings/);
  });

  test("@mobile cards are focusable and Enter opens the recording", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile layout only");
    await frigateApp.goto("/review");
    const page = frigateApp.page;
    const cards = page.locator('.review-item [role="button"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    await cards.first().focus();
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press("Enter");
    // The recording view is routed through router state, so assert on the
    // document title rather than the URL.
    await expect(page).toHaveTitle(/Recordings/);
  });
});

test.describe("Keyboard access: live context menu @critical", () => {
  test.skip(
    ({ frigateApp }) => frigateApp.isMobile,
    "Context menu is desktop-only",
  );

  test("context menu opens from a focused camera card", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    const page = frigateApp.page;
    const live = new LivePage(page, true);
    const card = live.cameraCard("front_door").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute("role", "button");
    await card.focus();
    await expect(card).toBeFocused();

    // Shift+F10 (or the Menu key) makes the browser fire `contextmenu` on the
    // focused element. Headless Chromium does not synthesize that event from
    // the key press, so dispatch what the OS would.
    await page.locator(":focus").dispatchEvent("contextmenu");
    const menu = page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 5_000 });

    // Arrow keys move through the items; Escape closes and restores focus.
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(card).toBeFocused();
  });
});
