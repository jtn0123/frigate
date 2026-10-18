/**
 * UI148 (upstream #24488): the History view opens on the sidebar tab picked
 * last time (Timeline, Events or Detail) instead of always on Timeline.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

async function openRecording(frigateApp: FrigateApp) {
  await frigateApp.goto("/review");
  await openFirstCard(frigateApp);
}

async function openFirstCard(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  const cards = page.locator('.review-item [role="button"]');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  await cards.first().focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle(/Recordings/);
}

// back to the review list, then a fresh page load, so only the saved
// setting can bring the tab back
async function leaveAndReopen(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page).not.toHaveTitle(/Recordings/);
  await page.reload();
  await openFirstCard(frigateApp);
}

test.describe("History tab memory @high", () => {
  test(
    "desktop reopens History on the last picked tab",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openRecording(frigateApp);

      const group = page.getByTestId("recording-view-switch");
      const events = group.getByRole("radio", { name: "Select events" });
      await expect(
        group.getByRole("radio", { name: "Select timeline" }),
      ).toHaveAttribute("aria-checked", "true");
      await events.click();
      await expect(events).toHaveAttribute("aria-checked", "true");

      await leaveAndReopen(frigateApp);
      await expect(
        page
          .getByTestId("recording-view-switch")
          .getByRole("radio", { name: "Select events" }),
      ).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    },
  );

  test(
    "phone reopens History on the last picked tab",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openRecording(frigateApp);

      const tabs = page.getByTestId("phone-timeline-tabs");
      const detail = tabs.getByRole("radio", { name: "Detail" });
      await detail.click();
      await expect(detail).toHaveAttribute("aria-checked", "true");

      await leaveAndReopen(frigateApp);
      await expect(
        page
          .getByTestId("phone-timeline-tabs")
          .getByRole("radio", { name: "Detail" }),
      ).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    },
  );
});
