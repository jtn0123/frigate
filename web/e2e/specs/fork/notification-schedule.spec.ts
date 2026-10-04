/**
 * D78: server-side notification quiet hours. The schedule editor in
 * Settings > Notifications (global and per camera), each camera's saved
 * state while edits are unsaved, saving through config/set, the warning
 * when the server's clock is not the browser's, and the inbox quiet hours
 * copy that points at the push schedule.
 */

import { expect, test } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";

// Wednesday 23:30 UTC, inside a 22:00 to 07:00 window. The schedule mock
// reads windows on UTC, so the badges do not depend on the host timezone.
const NOW = new Date("2026-01-14T23:30:00Z");
const NIGHTLY = [{ days: [], start: "22:00", end: "07:00" }];
const GLOBAL_PAGE = "/settings?page=notifications";

function cameraPage(camera: string) {
  return `/settings?page=cameraNotifications&camera=${camera}`;
}

/**
 * Freeze the clock and load a page with notifications on, a nightly global
 * window that the front door uses, a backyard that is never quiet, and a
 * garage with notifications off.
 */
async function installSchedule(frigateApp: FrigateApp) {
  await frigateApp.page.clock.setFixedTime(NOW);
  await frigateApp.installDefaults({
    config: {
      notifications: { enabled: true, quiet_hours: NIGHTLY },
      cameras: {
        front_door: { notifications: { enabled: true, quiet_hours: NIGHTLY } },
        backyard: { notifications: { enabled: true, quiet_hours: [] } },
        garage: { notifications: { enabled: false, quiet_hours: NIGHTLY } },
      },
    },
  });
  return installSettingsConfigRoutes(frigateApp.page);
}

async function openSchedule(frigateApp: FrigateApp, path: string) {
  const routes = await installSchedule(frigateApp);
  await frigateApp.goto(path);
  await expect(frigateApp.page.getByTestId("quiet-hours-field")).toBeVisible();
  return routes;
}

test.describe("Notification schedule @high", () => {
  // The browser shares the mocked server's zone unless a test says otherwise,
  // so the timezone warning only shows where a test asks for it
  test.use({ timezoneId: "UTC" });

  test.describe("desktop @desktop-only", () => {
    test("shows the global schedule and each camera's state", async ({
      frigateApp,
    }) => {
      await openSchedule(frigateApp, GLOBAL_PAGE);
      const { page } = frigateApp;

      await expect(page.getByTestId("quiet-status-scope")).toHaveAttribute(
        "data-state",
        "quiet",
      );
      await expect(page.getByTestId("quiet-status-text")).toHaveText(
        /^Pushes resume tomorrow at 7:00\sAM$/,
      );
      await expect(
        page.getByText("Times use the server's local time, UTC."),
      ).toBeVisible();
      await expect(page.getByTestId("quiet-timezone-warning")).toHaveCount(0);
      await expect(page.getByTestId("quiet-status-draft")).toHaveCount(0);
      await expect(page.getByTestId("quiet-status-front_door")).toHaveAttribute(
        "data-state",
        "quiet",
      );
      await expect(page.getByTestId("quiet-status-backyard")).toHaveAttribute(
        "data-state",
        "notifying",
      );
      await expect(page.getByTestId("quiet-status-garage")).toHaveAttribute(
        "data-state",
        "off",
      );
      await expect(page.getByTestId("quiet-camera-backyard")).toContainText(
        "Own schedule, never quiet",
      );
      await expect(page.getByTestId("quiet-camera-front_door")).toContainText(
        "Global schedule",
      );
    });

    test("adds a weeknight window and saves it with the section", async ({
      frigateApp,
    }) => {
      const { saved } = await openSchedule(frigateApp, GLOBAL_PAGE);
      const { page } = frigateApp;

      await page.getByRole("button", { name: "Add window" }).click();
      const added = page.getByRole("group", { name: "Window 2" });
      await expect(added).toBeVisible();
      await added.getByRole("button", { name: "Saturday" }).click();
      await added.getByRole("button", { name: "Sunday" }).click();
      await expect(
        added.getByRole("button", { name: "Sunday" }),
      ).toHaveAttribute("aria-pressed", "false");
      await added.getByLabel("Start time").fill("23:00");
      await added.getByLabel("End time").fill("06:30");
      // It counts on the nights it starts, so it names them and its mornings
      await expect(added).toContainText(
        /Mon to Fri nights, 11:00\sPM to 6:30\sAM/,
      );
      await expect(added).toContainText("Ends Tue to Sat mornings");
      await expect(added.getByTestId("quiet-window-days-label")).toHaveText(
        "Starts on",
      );
      await expect(page.getByTestId("quiet-status-draft")).toHaveText(
        /^After saving: quiet now\. Pushes resume tomorrow at 7:00\sAM$/,
      );

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => saved.length).toBe(1);
      expect(saved[0]).toMatchObject({
        config_data: {
          notifications: {
            quiet_hours: [
              { days: [], start: "22:00", end: "07:00" },
              {
                days: ["mon", "tue", "wed", "thu", "fri"],
                start: "23:00",
                end: "06:30",
              },
            ],
          },
        },
      });
    });

    test("keeps showing the saved state until the edit is saved", async ({
      frigateApp,
    }) => {
      const { saved } = await openSchedule(frigateApp, GLOBAL_PAGE);
      const { page } = frigateApp;

      await page.getByRole("button", { name: "Remove window 1" }).click();
      await expect(
        page.getByText("No quiet hours. Alerts are pushed at any time."),
      ).toBeVisible();
      // The server still holds pushes until the edit is saved
      await expect(page.getByTestId("quiet-status-scope")).toHaveAttribute(
        "data-state",
        "quiet",
      );
      await expect(page.getByTestId("quiet-status-text")).toHaveText(
        /^Pushes resume tomorrow at 7:00\sAM$/,
      );
      await expect(page.getByTestId("quiet-status-draft")).toHaveText(
        "After saving: no quiet hours",
      );
      await expect(page.getByTestId("quiet-status-front_door")).toHaveAttribute(
        "data-state",
        "quiet",
      );
      expect(saved).toHaveLength(0);
    });

    test("says whether a camera uses the global schedule", async ({
      frigateApp,
    }) => {
      await openSchedule(frigateApp, cameraPage("front_door"));
      const { page } = frigateApp;
      await expect(
        page.getByText("Uses the global schedule.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByTestId("quiet-status-scope")).toHaveAttribute(
        "data-state",
        "quiet",
      );
      await expect(page.getByTestId("quiet-camera-list")).toHaveCount(0);
      // What is never held, and where held alerts go, show on a camera too
      await expect(page.getByTestId("quiet-hours-exempt")).toHaveText(
        "Camera offline alerts, AI watch alerts, and test notifications are always sent.",
      );
      await expect(
        page.getByText("none are sent later", { exact: false }),
      ).toBeVisible();

      await frigateApp.goto(cameraPage("backyard"));
      await expect(
        page.getByText("This camera has its own schedule", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("No quiet hours. Alerts are pushed at any time."),
      ).toBeVisible();
      await expect(page.getByTestId("quiet-status-scope")).toHaveAttribute(
        "data-state",
        "notifying",
      );
    });

    test.describe("browser on another clock", () => {
      test.use({ timezoneId: "America/Los_Angeles" });

      test("warns that the server's clock decides and suggests this browser's zone", async ({
        frigateApp,
      }) => {
        const { saved } = await openSchedule(frigateApp, GLOBAL_PAGE);
        const { page } = frigateApp;

        // January in Los Angeles is UTC-8
        const warning = page.getByTestId("quiet-timezone-warning");
        await expect(warning).toContainText(
          "Quiet hours follow the server clock (UTC), 8 hours ahead of this browser",
        );
        await expect(
          page.getByText("Times use the server's local time, UTC."),
        ).toHaveCount(0);

        await warning
          .getByRole("button", { name: "Use America/Los_Angeles" })
          .click();
        // UI settings open with the zone filled in, and nothing is saved
        await expect(
          page.getByRole("combobox").filter({ hasText: "America/Los_Angeles" }),
        ).toBeVisible();
        await expect(
          page.getByText("You have unsaved changes").first(),
        ).toBeVisible();
        expect(saved).toHaveLength(0);
      });
    });

    test("inbox quiet hours say they only cover the inbox and link to the push schedule", async ({
      frigateApp,
    }) => {
      await installSchedule(frigateApp);
      await frigateApp.goto("/review");
      const { page } = frigateApp;
      await page.getByTestId("inbox-bell").click();
      const panel = page.getByTestId("inbox-panel");
      await panel.getByRole("button", { name: "Inbox settings" }).click();
      await expect(
        panel.getByRole("switch", { name: "Inbox quiet hours" }),
      ).toBeVisible();
      await expect(
        panel.getByText("Only affects this inbox in this browser.", {
          exact: false,
        }),
      ).toBeVisible();

      await panel
        .getByRole("button", { name: "Pause push notifications on a schedule" })
        .click();
      await expect(page).toHaveURL(/\/settings\?page=notifications$/);
      await expect(page.getByTestId("quiet-hours-field")).toBeVisible();
    });
  });

  test.describe("mobile @mobile-only", () => {
    test("edits the schedule on a phone @mobile", async ({ frigateApp }) => {
      await openSchedule(frigateApp, GLOBAL_PAGE);
      const { page } = frigateApp;
      const window = page.getByRole("group", { name: "Window 1" });
      await window.scrollIntoViewIfNeeded();
      const monday = window.getByRole("button", { name: "Monday" });
      await expect(monday).toHaveAttribute("aria-pressed", "true");
      await monday.click();
      await expect(monday).toHaveAttribute("aria-pressed", "false");
      await expect(
        page.getByText("You have unsaved changes").first(),
      ).toBeVisible();
      await expect(page.getByTestId("quiet-status-draft")).toBeVisible();

      // The day chips and times stay inside the phone's width
      const width = page.viewportSize()?.width ?? 0;
      const box = await window.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(
        width,
      );

      // A fingertip needs 44 px: the time inputs and the camera edit links
      const start = await window.getByLabel("Start time").boundingBox();
      expect(start?.height ?? 0).toBeGreaterThanOrEqual(44);
      const edit = await page
        .getByRole("link", { name: "Edit the Backyard schedule" })
        .boundingBox();
      expect(edit?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(edit?.width ?? 0).toBeGreaterThanOrEqual(44);
      await expect(page.getByTestId("quiet-status-backyard")).toHaveAttribute(
        "data-state",
        "notifying",
      );
    });
  });
});
