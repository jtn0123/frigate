/**
 * Fork: timeline snap-to-event and keyboard stepping (UI item 8).
 *
 * Recording view already has a draggable handlebar. This spec covers the
 * fork additions: focus/aria on the handlebar, arrow-key stepping between
 * review start times, and a larger touch target when the flag is on.
 */

import type { Page } from "@playwright/test";
import { test, expect, FrigateApp } from "../../fixtures/frigate-test";

async function mockTimelineApis(page: Page) {
  await page.route("**/api/review/activity/motion**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/recordings/unavailable**", (route) =>
    route.fulfill({ json: [] }),
  );
}

async function openRecordingWithHandlebar(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  await mockTimelineApis(page);
  await frigateApp.goto("/review");
  const cards = page.locator('.review-item [role="button"]');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  await cards.first().click();
  await expect(page).toHaveTitle(/Recordings/);
  const handle = page.getByTestId("timeline-handlebar");
  await expect(handle).toBeVisible({ timeout: 15_000 });
  return handle;
}

test.describe("Timeline scrubber @high", () => {
  test(
    "handlebar is focusable and arrow keys step between events",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const handle = await openRecordingWithHandlebar(frigateApp);
      await expect(handle).toHaveAttribute("data-touch-target", "large");
      await handle.focus();
      await expect(handle).toBeFocused();

      const before = await handle.getAttribute("data-handlebar-time");
      expect(before).toBeTruthy();

      await frigateApp.page.keyboard.press("ArrowRight");
      const afterRight = await handle.getAttribute("data-handlebar-time");
      expect(afterRight).toBeTruthy();

      await frigateApp.page.keyboard.press("ArrowLeft");
      const afterLeft = await handle.getAttribute("data-handlebar-time");
      expect(afterLeft).toBeTruthy();

      // Two front_door reviews exist in the mock data, so a step should
      // land on a different event than the one we started on.
      expect(new Set([before, afterRight, afterLeft]).size).toBeGreaterThan(1);
    },
  );

  test(
    "handlebar keeps a larger touch target on a phone @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const handle = await openRecordingWithHandlebar(frigateApp);
      await expect(handle).toHaveAttribute("data-touch-target", "large");
      const box = await handle.locator(":scope > div").first().boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    },
  );
});
