/**
 * Fork B43: upstream multi-fix PRs (batch 10), the web fixes upstream has
 * no test for.
 *
 * - #24659: a repeated notice shows when it last occurred, and the Explore
 *   detail menu stops retrying a review lookup that 404s.
 */

import { test, expect } from "../../fixtures/frigate-test";

const NOW = Math.floor(Date.now() / 1000);

const REPEATED_NOTICE = {
  id: "detector_stuck",
  kind: "detector_stuck",
  severity: "warning",
  category: "detector",
  scope: null,
  params: { detector: "ov" },
  link: "/system#general",
  first_seen: NOW - 7200,
  last_seen: NOW - 60,
  count: 3,
  acknowledgeable: true,
  acknowledged_at: null,
  muted_at: null,
};

test.describe("Notices show their last occurrence (B43, #24659) @medium", () => {
  test("a repeated notice names its last time and count", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      stats: { detectors: { cpu: { inference_speed: 10 } } },
      notices: [REPEATED_NOTICE],
    });
    await frigateApp.goto("/system#notices");

    const row = frigateApp.page.locator(
      "[data-testid='health-problem-notice:detector_stuck']",
    );
    await expect(row).toContainText(/Last occurred .* · 3 times since /, {
      timeout: 15_000,
    });
  });

  test("a single notice reads as occurred once", async ({ frigateApp }) => {
    await frigateApp.installDefaults({
      stats: { detectors: { cpu: { inference_speed: 10 } } },
      notices: [{ ...REPEATED_NOTICE, count: 1, last_seen: NOW - 7200 }],
    });
    await frigateApp.goto("/system#notices");

    const row = frigateApp.page.locator(
      "[data-testid='health-problem-notice:detector_stuck']",
    );
    await expect(row).toContainText("Occurred ", { timeout: 15_000 });
    await expect(row).not.toContainText("times since");
  });
});

test.describe("Explore detail menu review lookup (B43, #24659) @medium", () => {
  test("a 404 review lookup is not retried", async ({ frigateApp }) => {
    const { page } = frigateApp;
    let lookups = 0;
    await page.route("**/api/review/event/*", (route) => {
      lookups += 1;
      return route.fulfill({ status: 404, json: { success: false } });
    });

    await frigateApp.goto("/explore?event_id=event-person-001");
    await expect.poll(() => lookups, { timeout: 15_000 }).toBeGreaterThan(0);

    // SWR's first error retry fires 2.5 to 7.5 seconds after the failure
    await page.waitForTimeout(9_000);
    expect(lookups).toBe(1);
  });
});
