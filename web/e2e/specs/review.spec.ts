/**
 * Review/Events page tests -- CRITICAL tier.
 *
 * Severity tabs, filter popovers, calendar, show-reviewed toggle,
 * timeline, and the nested-overlay regression migrated from
 * radix-overlay-regressions.spec.ts.
 */

import { test, expect } from "../fixtures/frigate-test";
import { BasePage } from "../pages/base.page";
import { ReviewPage } from "../pages/review.page";
import {
  expectBodyInteractive,
  waitForBodyInteractive,
} from "../helpers/overlay-interaction";

test.describe("Review — deep link @critical", () => {
  test("?id= opens an older review on its own day", async ({ frigateApp }) => {
    const page = frigateApp.page;
    const now = Date.now() / 1000;
    const start = now - 3 * 86400;
    await page.route("**/api/review/review-old-001", (route) =>
      route.fulfill({
        json: {
          id: "review-old-001",
          camera: "front_door",
          start_time: start,
          end_time: start + 30,
          severity: "alert",
          has_been_reviewed: false,
          thumb_path: "",
          data: {
            detections: [],
            objects: ["person"],
            sub_labels: [],
            significant_motion_areas: [],
            zones: [],
            audio: [],
          },
        },
      }),
    );
    const listRanges: { after: number; before: number }[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (!url.pathname.endsWith("/api/review")) return;
      const after = Number(url.searchParams.get("after"));
      const before = Number(url.searchParams.get("before"));
      if (after && before) listRanges.push({ after, before });
    });

    await frigateApp.goto("/review?id=review-old-001");

    // wait for a list read that covers the review, then check it is that
    // review's day and not the last 24 hours (UI67)
    const covering = () =>
      listRanges.find((range) => range.after <= start && start <= range.before);
    await expect
      .poll(() => covering() !== undefined, { timeout: 10_000 })
      .toBe(true);
    expect(covering()?.before).toBeLessThan(now - 86400);
  });
});

test.describe("Review — severity tabs @critical", () => {
  test("tabs render with Alerts default-on", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    await expect(review.alertsTab).toBeVisible({ timeout: 10_000 });
    await expect(review.detectionsTab).toBeVisible();
    await expect(review.motionTab).toBeVisible();
    await expect(review.alertsTab).toHaveAttribute("data-state", "on");
  });

  test("clicking Detections flips data-state", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    await expect(review.alertsTab).toBeVisible({ timeout: 10_000 });
    await review.detectionsTab.click();
    await expect(review.detectionsTab).toHaveAttribute("data-state", "on");
    await expect(review.alertsTab).toHaveAttribute("data-state", "off");
  });

  test("clicking Motion flips data-state", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    await expect(review.alertsTab).toBeVisible({ timeout: 10_000 });
    await review.motionTab.click();
    await expect(review.motionTab).toHaveAttribute("data-state", "on");
  });

  test("switching back to Alerts works", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    await review.detectionsTab.click();
    await expect(review.detectionsTab).toHaveAttribute("data-state", "on");
    await review.alertsTab.click();
    await expect(review.alertsTab).toHaveAttribute("data-state", "on");
  });

  test("switching tabs updates active data-state (client-side filter)", async ({
    frigateApp,
  }) => {
    // The severity tabs filter the already-fetched review data client-side;
    // they do not trigger a new /api/review network request. This test
    // verifies the state-change assertion that the tab switch takes effect.
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    await expect(review.alertsTab).toBeVisible({ timeout: 10_000 });
    await expect(review.alertsTab).toHaveAttribute("data-state", "on");
    await review.detectionsTab.click();
    await expect(review.detectionsTab).toHaveAttribute("data-state", "on");
    await expect(review.alertsTab).toHaveAttribute("data-state", "off");
  });
});

test.describe("Review — filters (desktop) @critical", () => {
  test.skip(
    ({ frigateApp }) => frigateApp.isMobile,
    "Filter bar differs on mobile",
  );

  test("Cameras popover lists configured camera names", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, true);
    await expect(review.camerasFilterTrigger).toBeVisible({ timeout: 5_000 });
    await review.camerasFilterTrigger.click();
    await expect(review.filterOverlay).toBeVisible({ timeout: 3_000 });
    await expect(frigateApp.page.getByText("Front Door")).toBeVisible();
  });

  test("closing the Cameras popover with Escape leaves body interactive", async ({
    frigateApp,
  }) => {
    // Migrated from radix-overlay-regressions.spec.ts.
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, true);
    await review.camerasFilterTrigger.click();
    await expect(review.filterOverlay).toBeVisible({ timeout: 3_000 });
    await frigateApp.page.keyboard.press("Escape");
    await expect(review.filterOverlay).not.toBeVisible({ timeout: 3_000 });
    await waitForBodyInteractive(frigateApp.page);
    await expectBodyInteractive(frigateApp.page);
  });

  test("Labels are shown inside the General Filter dialog", async ({
    frigateApp,
  }) => {
    // Labels are surfaced inside the "Filter" button's GeneralFilterContent
    // dialog, not as a standalone top-level button. We open that dialog and
    // confirm labels from the camera config are listed there.
    await frigateApp.goto("/review");
    const filterBtn = frigateApp.page
      .getByRole("button", { name: /^filter$/i })
      .first();
    await expect(filterBtn).toBeVisible({ timeout: 5_000 });
    await filterBtn.click();

    const overlay = frigateApp.page.locator(
      "[data-radix-popper-content-wrapper], [role='dialog']",
    );
    await expect(overlay.first()).toBeVisible({ timeout: 3_000 });
    // The default mock config for front_door tracks "person"
    await expect(overlay.first().getByText(/person/i)).toBeVisible();
    await frigateApp.page.keyboard.press("Escape");
  });

  test("Zones popover lists configured zones inside the General Filter dialog", async ({
    frigateApp,
  }) => {
    // Override config to guarantee a known zone on front_door.
    await frigateApp.installDefaults({
      config: {
        cameras: {
          front_door: {
            zones: {
              front_yard: { coordinates: "0.1,0.1,0.9,0.1,0.9,0.9,0.1,0.9" },
            },
          },
        },
      },
    });
    await frigateApp.goto("/review");
    const filterBtn = frigateApp.page
      .getByRole("button", { name: /^filter$/i })
      .first();
    await expect(filterBtn).toBeVisible({ timeout: 5_000 });
    await filterBtn.click();

    const overlay = frigateApp.page.locator(
      "[data-radix-popper-content-wrapper], [role='dialog']",
    );
    await expect(overlay.first()).toBeVisible({ timeout: 3_000 });
    await expect(overlay.first().getByText(/front.?yard/i)).toBeVisible();
    await frigateApp.page.keyboard.press("Escape");
  });

  test("Calendar trigger opens a date picker popover", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, true);
    await expect(review.calendarTrigger).toBeVisible({ timeout: 5_000 });
    await review.calendarTrigger.click();

    // react-day-picker v9 renders a role="grid" calendar with day cells
    // as buttons inside gridcells (e.g. "Wednesday, April 1st, 2026").
    // The calendar is placed directly in the DOM (not always inside a
    // Radix popper wrapper), so scope by the grid role instead.
    const calendarGrid = frigateApp.page.locator('[role="grid"]').first();
    await expect(calendarGrid).toBeVisible({ timeout: 3_000 });
    const dayButton = calendarGrid.locator('[role="gridcell"] button').first();
    await expect(dayButton).toBeVisible({ timeout: 3_000 });
    await frigateApp.page.keyboard.press("Escape");
  });

  test("Show Reviewed switch flips its checked state", async ({
    frigateApp,
  }) => {
    // "Show Reviewed" is a Radix Switch (role=switch), not a button.
    // It filters review data client-side; it does not trigger a new
    // /api/review network request. Verify the switch state toggles.
    await frigateApp.goto("/review");
    const showReviewedSwitch = frigateApp.page.getByRole("switch", {
      name: /show reviewed/i,
    });
    await expect(showReviewedSwitch).toBeVisible({ timeout: 5_000 });

    // Record initial checked state and click to toggle
    const initialChecked =
      await showReviewedSwitch.getAttribute("aria-checked");
    await showReviewedSwitch.click();
    const flippedChecked = initialChecked === "true" ? "false" : "true";
    await expect(showReviewedSwitch).toHaveAttribute(
      "aria-checked",
      flippedChecked,
    );
  });
});

test.describe("Review — timeline (desktop) @critical", () => {
  test.skip(
    ({ frigateApp }) => frigateApp.isMobile,
    "Timeline not shown on mobile",
  );

  test("timeline renders time markers", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    await expect(frigateApp.page.locator("#pageRoot")).toContainText(
      /[AP]M|\d+:\d+/,
      { timeout: 10_000 },
    );
  });
});

test.describe("Review — mobile @critical @mobile", () => {
  test.skip(({ frigateApp }) => !frigateApp.isMobile, "Mobile-only");

  test("severity tabs render on mobile", async ({ frigateApp }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, false);
    await expect(review.alertsTab).toBeVisible({ timeout: 10_000 });
    await expect(review.detectionsTab).toBeVisible();
  });

  test("back navigation returns to Live", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    const base = new BasePage(frigateApp.page, false);
    await base.navigateTo("/review");
    await expect(frigateApp.page).toHaveURL(/\/review/);
    await base.navigateTo("/");
    await expect(frigateApp.page).toHaveURL(/\/$/);
  });
});

test.describe("Review — fixture data renders like the real API @high", () => {
  // D20: reviews.json used to carry ISO-string times, "/clips/..." thumb
  // paths and a summary without last24Hours, so every card read "Invalid
  // Time", every thumbnail was a broken "//clips" URL, and the severity
  // badges read 0. These assertions keep the fixtures honest.
  test("cards show real times and loaded thumbnails", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    const card = review.reviewItems.first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).not.toContainText(/invalid/i);

    const thumb = card.locator("img").first();
    await expect(thumb).toHaveAttribute("src", /\/clips\/review\//);
    await expect(thumb).not.toHaveAttribute("src", /\/\/clips/);
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test("severity badge counts come from last24Hours", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/review");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    // review-summary.json: last24Hours total_alert 2, reviewed_alert 1
    await expect(review.alertsTab).toContainText("1", { timeout: 10_000 });
  });
});

test.describe("Review — recording view loading state @high @mobile", () => {
  // UI48: while a recording loaded with no preview for the range, the
  // preview player's "No Preview Found" sat under the loading spinner.
  test("the spinner does not cover the no-preview message", async ({
    frigateApp,
  }) => {
    // Hold the camera's recordings so the view stays in its loading state
    // past the player's 1 s loading timer.
    await frigateApp.page.route("**/api/*/recordings?**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      await route.fulfill({ json: [] }).catch(() => undefined);
    });
    await frigateApp.goto("/review");
    const page = frigateApp.page;
    const cards = page.locator('.review-item [role="button"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    await cards.first().click();
    await expect(page).toHaveTitle(/Recordings/);

    const spinner = page.getByLabel("Loading…").first();
    await expect(spinner).toBeVisible({ timeout: 5_000 });

    const overlapping = await page.evaluate(() => {
      const spin = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label="Loading…"]'),
      ).find((el) => el.getBoundingClientRect().width > 0);
      if (!spin) return -1;
      const s = spin.getBoundingClientRect();
      return (
        Array.from(document.querySelectorAll<HTMLElement>("div"))
          // innerText, not textContent: a wrapper around the hidden preview
          // player would otherwise "contain" the message it no longer shows
          .filter(
            (el) =>
              el.innerText.trim() === "No Preview Found" &&
              el.checkVisibility(),
          )
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.left < s.right &&
              r.right > s.left &&
              r.top < s.bottom &&
              r.bottom > s.top
            );
          }).length
      );
    });
    expect(overlapping).toBe(0);
  });
});

test.describe("Review, camera group links @high", () => {
  test("a link to a camera group that no longer exists opens the page", async ({
    frigateApp,
  }) => {
    // UI93: the group effect read the missing group's cameras and threw,
    // which replaced the page with the error boundary
    await frigateApp.goto("/review?group=removed_group");
    const review = new ReviewPage(frigateApp.page, !frigateApp.isMobile);
    await expect(review.alertsTab).toBeVisible({ timeout: 10_000 });
    await expect(frigateApp.page).not.toHaveURL(/group=/);
    expect(
      await frigateApp.page.getByTestId("fork-error-boundary").count(),
    ).toBe(0);
  });
});
