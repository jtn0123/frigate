/**
 * Fork: timeline snap-to-event and keyboard stepping (UI item 8).
 *
 * Recording view already has a draggable handlebar. This spec covers the
 * fork additions: focus/aria on the handlebar, arrow-key stepping between
 * review start times, and a larger touch target when the flag is on.
 */

import type { Page } from "@playwright/test";
import { test, expect, FrigateApp } from "../../fixtures/frigate-test";

/** One alert inside the last 24 hours, so the timeline can snap to it. */
function recentReview() {
  const start = Math.floor(Date.now() / 1000) - 1800;
  return {
    id: "review-snap-001",
    camera: "front_door",
    start_time: start,
    end_time: start + 30,
    has_been_reviewed: false,
    severity: "alert",
    thumb_path: "/clips/front_door/review-snap-001-thumb.jpg",
    data: {
      audio: [],
      detections: ["person-abc123"],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

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
    "releasing the handlebar far from any review leaves it where it was dropped",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const review = recentReview();
      await frigateApp.installDefaults({ reviews: [review] });
      await page.route(`**/api/review/${review.id}`, (route) =>
        route.fulfill({ json: review }),
      );
      const handle = await openRecordingWithHandlebar(frigateApp);
      const before = Number(await handle.getAttribute("data-handlebar-time"));
      // Press on a point of the playhead that nothing (such as the zoom
      // buttons) covers.
      const point = await handle
        .locator(":scope > div")
        .first()
        .evaluate((grip) => {
          const root = grip.closest('[data-testid="timeline-handlebar"]');
          const rect = grip.getBoundingClientRect();
          for (let y = rect.top + 1; y < rect.bottom; y += 2) {
            for (let x = rect.left + 1; x < rect.right; x += 2) {
              const hit = document.elementFromPoint(x, y);
              if (hit && root?.contains(hit)) return { x, y };
            }
          }
          return null;
        });
      expect(point).toBeTruthy();
      const { x, y } = point!;

      // 200 px at 30 s per 8 px segment is about 12 minutes later, far past
      // the snap reach (4 segments, 120 s), so the release must stay where
      // it was dropped instead of jumping back to the review's start.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 200, { steps: 10 });
      await page.mouse.up();
      // Let the snap-on-release effect commit before reading the time.
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );

      await expect
        .poll(async () =>
          Number(await handle.getAttribute("data-handlebar-time")),
        )
        .toBeGreaterThan(before + 300);
      const after = Number(await handle.getAttribute("data-handlebar-time"));
      expect(Math.abs(after - review.start_time)).toBeGreaterThan(120);
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
