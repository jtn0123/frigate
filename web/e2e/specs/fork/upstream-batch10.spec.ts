/**
 * Fork B43: upstream multi-fix PRs (batch 10), the web fixes upstream has
 * no test for.
 *
 * - #24659: a repeated notice shows when it last occurred, and the Explore
 *   detail menu stops retrying a review lookup that 404s.
 * - #24684: with built-in auth disabled, Settings > Users notes that the
 *   accounts only apply once it is enabled and hides Add User and Reset
 *   Password.
 * - #24829: the global notifications ttl sits under Advanced Settings, warns
 *   when set to Reliable, and is hidden on the camera form.
 */

import { test, expect } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";

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

    await frigateApp.goto("/explore?labels=person");
    const firstResult = page.locator("[data-start]").first();
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();
    await expect.poll(() => lookups, { timeout: 15_000 }).toBeGreaterThan(0);

    // The app's onErrorRetry (C17 read-retry.ts) waits 5 or 10 seconds,
    // depending on the key's jitter, before the first retry of a read
    await page.waitForTimeout(11_000);
    expect(lookups).toBe(1);
  });
});

test.describe("Users settings with auth disabled (B43, #24684) @medium", () => {
  const USERS = [
    { username: "admin", role: "admin" },
    { username: "alice", role: "viewer" },
  ];

  test("hides account actions and explains why", async ({ frigateApp }) => {
    await frigateApp.installDefaults({
      config: { auth: { enabled: false } },
      users: USERS,
    });
    await frigateApp.goto("/settings?page=users");

    const { page } = frigateApp;
    await expect(
      page.getByText("Built-in authentication is disabled."),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Add User" })).toHaveCount(0);
    await expect(page.getByText("alice")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Reset Password|Password/ }),
    ).toHaveCount(0);
  });

  test("keeps account actions when auth is enabled", async ({ frigateApp }) => {
    await frigateApp.installDefaults({
      config: { auth: { enabled: true } },
      users: USERS,
    });
    await frigateApp.goto("/settings?page=users");

    const { page } = frigateApp;
    await expect(page.getByRole("button", { name: "Add User" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("Built-in authentication is disabled."),
    ).toHaveCount(0);
  });
});

test.describe("Notification TTL setting (B43, #24829) @medium", () => {
  test("global ttl is an advanced setting that warns when reliable", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: { notifications: { enabled: true, ttl: "reliable" } },
    });
    await installSettingsConfigRoutes(page);
    await frigateApp.goto("/settings?page=notifications");

    await expect(page.getByText("Notification TTL")).toHaveCount(0);
    await page
      .getByRole("button", { name: /Advanced Settings/ })
      .first()
      .click();
    await expect(page.getByText("Notification TTL").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("Notifications can arrive up to 30 seconds late"),
    ).toBeVisible();
  });

  test("the camera form does not offer ttl", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: {
        notifications: { enabled: true },
        cameras: { front_door: { notifications: { enabled: true } } },
      },
    });
    await installSettingsConfigRoutes(page);
    await frigateApp.goto(
      "/settings?page=cameraNotifications&camera=front_door",
    );

    await expect(page.locator("#pageRoot")).toBeVisible({ timeout: 10_000 });
    const advanced = page.getByRole("button", { name: /Advanced Settings/ });
    if ((await advanced.count()) > 0) await advanced.first().click();
    await expect(page.getByText("Notification TTL")).toHaveCount(0);
  });
});
