/**
 * UI157: suspending a camera's notifications until a chosen time (upstream
 * #23286). The Suspend menu in Settings > Notifications and the Live context
 * menu open a dialog with a date and a time; Apply sends the minutes until
 * then on the camera's notifications/suspend topic, and only a time still in
 * the future can be applied.
 */

import type { Locator } from "@playwright/test";
import { expect, test, type FrigateApp } from "../../fixtures/frigate-test";
import { LivePage } from "../../pages/live.page";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";
import { installWsFrameCapture, readWsFrames } from "../../helpers/ws-frames";
import { expectBodyInteractive } from "../../helpers/overlay-interaction";

// Noon UTC on a Wednesday; the browser shares UTC, so the dialog's date and
// time read the same on every runner.
const NOW = new Date("2026-07-15T12:00:00Z");
const NOTIFYING = { enabled: true, enabled_in_config: true };

async function installNotifications(frigateApp: FrigateApp) {
  await frigateApp.page.clock.setFixedTime(NOW);
  await installWsFrameCapture(frigateApp.page);
  await frigateApp.installDefaults({
    config: {
      notifications: NOTIFYING,
      cameras: { front_door: { notifications: NOTIFYING } },
    },
  });
  await installSettingsConfigRoutes(frigateApp.page);
  // with notifications on the page asks for the push key up front
  await frigateApp.page.route("**/api/notifications/pubkey", (route) =>
    route.fulfill({ json: "test-vapid-public-key" }),
  );
}

/**
 * The camera_activity snapshot has notifications off, so turn them on until
 * `ready` shows; a push that lands before the connect frame is overwritten.
 */
async function notificationsOn(frigateApp: FrigateApp, ready: Locator) {
  await expect(async () => {
    frigateApp.ws.send("front_door/notifications/state", "ON");
    await expect(ready).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Every minute count sent on front_door's suspend topic, in order. */
async function suspendMinutes(frigateApp: FrigateApp): Promise<unknown[]> {
  const minutes: unknown[] = [];
  for (const frame of await readWsFrames(frigateApp.page)) {
    if (!frame.startsWith("{")) continue;
    const { topic, payload } = JSON.parse(frame) as {
      topic?: string;
      payload?: unknown;
    };
    if (topic === "front_door/notifications/suspend") minutes.push(payload);
  }
  return minutes;
}

async function openCustomDialogFromSettings(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  await frigateApp.goto("/settings?page=notifications");
  const suspend = page.getByRole("button", { name: "Suspend", exact: true });
  await notificationsOn(frigateApp, suspend);

  await suspend.click();
  await page.getByRole("menuitem", { name: "Suspend until..." }).click();

  const dialog = page.getByRole("dialog", { name: "Custom suspension time" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Custom notification suspension (UI157) @medium @mobile", () => {
  test.use({ timezoneId: "UTC" });

  test("suspends until a picked day and time", async ({ frigateApp }) => {
    await installNotifications(frigateApp);
    const dialog = await openCustomDialogFromSettings(frigateApp);
    const { page } = frigateApp;
    const time = dialog.getByLabel("Suspend until");

    // it opens an hour ahead
    await expect(time).toHaveValue("13:00");
    await dialog.getByRole("button", { name: "Jul 15, 2026" }).click();

    // days before today cannot be picked
    await expect(
      dialog.getByRole("button", { name: /July 14th, 2026/ }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: /July 17th, 2026/ }).click();
    await expect(
      dialog.getByRole("button", { name: "Jul 17, 2026" }),
    ).toBeVisible();

    await time.fill("18:30");
    await dialog.getByRole("button", { name: "Apply" }).click();

    await expect(dialog).toBeHidden();
    // two days and six and a half hours
    await expect
      .poll(() => suspendMinutes(frigateApp))
      .toEqual([2 * 24 * 60 + 6 * 60 + 30]);
    await expectBodyInteractive(page);

    // the server reports the suspension and the switch offers to cancel it
    const until = Math.floor(Date.parse("2026-07-17T18:30:00Z") / 1000);
    frigateApp.ws.send("front_door/notifications/suspended", String(until));
    await expect(
      page.getByRole("button", { name: "Cancel Suspension" }),
    ).toBeVisible();
  });

  test("refuses a time that has passed", async ({ frigateApp }) => {
    await installNotifications(frigateApp);
    const dialog = await openCustomDialogFromSettings(frigateApp);

    await dialog.getByLabel("Suspend until").fill("11:00");

    await expect(dialog.getByText("Pick a time in the future.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(await suspendMinutes(frigateApp)).toEqual([]);
  });
});

test.describe("Custom suspension from the Live menu (UI157) @medium", () => {
  test.use({ timezoneId: "UTC" });

  test(
    "the context menu offers a custom time",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await installNotifications(frigateApp);
      const { page } = frigateApp;
      await frigateApp.goto("/");

      const live = new LivePage(page, true);
      const menu = await live.openContextMenuOn("front_door");
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: "Notifications" }).hover();
      const custom = page.getByRole("menuitem", { name: "Custom..." });
      await notificationsOn(frigateApp, custom);
      await custom.click();

      const dialog = page.getByRole("dialog", {
        name: "Custom suspension time",
      });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Apply" }).click();

      await expect(dialog).toBeHidden();
      await expect.poll(() => suspendMinutes(frigateApp)).toEqual([60]);
      await expectBodyInteractive(page);
    },
  );
});
