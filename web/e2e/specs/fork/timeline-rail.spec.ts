/**
 * Fork: recording view timeline rail (UI106).
 *
 * The current-time pill must stay fully visible and clear of the zoom
 * buttons, the tick labels must be legible, and the desktop view switch
 * reads as one segmented control.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect, FrigateApp } from "../../fixtures/frigate-test";

type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function inside(inner: Box, outer: Box) {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

async function openRecording(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  await page.route("**/api/review/activity/motion**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/recordings/unavailable**", (route) =>
    route.fulfill({ json: [] }),
  );
  await frigateApp.goto("/review");
  const cards = page.locator('.review-item [role="button"]');
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  await cards.first().click();
  await expect(page).toHaveTitle(/Recordings/);
  const handle = page.getByTestId("timeline-handlebar");
  await expect(handle).toBeVisible({ timeout: 15_000 });
  return handle;
}

/** The red pill that shows the current time. */
function pillOf(handle: Locator) {
  return handle.locator("div.rounded-full").first();
}

/** Wait for the rail's smooth scroll to settle before measuring. */
async function settle(page: Page) {
  let last = -1;
  await expect
    .poll(
      async () => {
        const top = await page
          .getByTestId("timeline-handlebar")
          .evaluate((el) => el.parentElement?.scrollTop ?? 0);
        const still = top === last;
        last = top;
        return still;
      },
      { intervals: [250] },
    )
    .toBe(true);
}

async function expectPillFullyVisible(page: Page, handle: Locator) {
  await settle(page);
  const pill = await pillOf(handle).boundingBox();
  const rail = await handle.evaluate((el) => {
    const rect = el.parentElement!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const viewport = page.viewportSize()!;
  expect(pill).toBeTruthy();
  expect(pill!.height).toBeGreaterThan(0);
  // inside the window and inside the rail that clips it
  expect(
    inside(pill!, {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    }),
  ).toBe(true);
  expect(inside(pill!, rail)).toBe(true);

  const zoom = page.getByTestId("timeline-zoom-controls");
  // the recording view shows zoom buttons on desktop and on a phone
  await expect(zoom).toBeVisible();
  const buttons = await zoom.getByRole("button").all();
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box).toBeTruthy();
    expect(intersects(pill!, box!)).toBe(false);
  }
}

test.describe("Recording timeline rail @high", () => {
  test(
    "current-time pill is fully visible and clear of the zoom buttons",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const handle = await openRecording(frigateApp);
      await expectPillFullyVisible(page, handle);

      // desktop keeps the zoom controls in a bordered group above the rail
      const zoom = page.getByTestId("timeline-zoom-controls");
      await expect(zoom).toBeVisible();
      const zoomBox = (await zoom.boundingBox())!;
      const rail = (await handle.evaluate((el) => {
        const rect = el.parentElement!.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }))!;
      expect(zoomBox.y + zoomBox.height).toBeLessThanOrEqual(rail.y + 0.5);

      // zooming still works and the pill stays in view afterwards
      const zoomIn = zoom.getByRole("button", { name: /zoom in/i });
      await zoomIn.click();
      await expectPillFullyVisible(page, handle);
      await zoom.getByRole("button", { name: /zoom out/i }).click();
      await expectPillFullyVisible(page, handle);
    },
  );

  test(
    "current-time pill stays fully visible on a phone @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const handle = await openRecording(frigateApp);
      await expectPillFullyVisible(frigateApp.page, handle);
    },
  );

  test(
    "tick labels are at least 11 px on desktop",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openRecording(frigateApp);
      // labels read like "1:30 AM" or "13:30"
      const labels = page
        .getByTestId("timeline-handlebar")
        .locator("xpath=..")
        .locator(".segment .absolute.z-10 > div")
        .filter({ hasText: /\d:\d\d/ });
      await expect(labels.first()).toBeVisible();
      const sizes = await labels.evaluateAll((els) =>
        els.map((label) => parseFloat(getComputedStyle(label).fontSize)),
      );
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11);
    },
  );

  test(
    "view switch reads as one segmented control",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openRecording(frigateApp);
      const group = page.getByTestId("recording-view-switch");
      await expect(group).toBeVisible();
      const style = await group.evaluate((el) => {
        const active = el.querySelector<HTMLElement>('[data-state="on"]')!;
        const idle = el.querySelector<HTMLElement>('[data-state="off"]')!;
        return {
          group: getComputedStyle(el).backgroundColor,
          active: getComputedStyle(active).backgroundColor,
          idle: getComputedStyle(idle).backgroundColor,
          shadow: getComputedStyle(active).boxShadow,
        };
      });
      const transparent = "rgba(0, 0, 0, 0)";
      expect(style.group).not.toBe(transparent);
      expect(style.active).not.toBe(style.group);
      expect(style.idle).toBe(transparent);
      expect(style.shadow).not.toBe("none");
    },
  );
});
