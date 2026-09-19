/**
 * Fork: settings polish (UI102 to UI105, UI111 to UI115).
 *
 * The "On this page" rail keeps clear of the form, Users says why it could
 * not load, Triggers explains its prerequisite, Generative AI has an empty
 * state, and Camera management, Media sync, Frigate+, Notifications and
 * Profiles read clearly with the mock config (no providers, no Frigate+ key,
 * no notification cameras, no profiles).
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";

type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box as Box;
}

async function openSettings(page: Page, settingsPage: string) {
  await installSettingsConfigRoutes(page);
  await page.goto(`/settings?page=${settingsPage}`);
  await page.waitForSelector("#pageRoot", { timeout: 10_000 });
}

test.describe("Settings rail (UI102) @high", () => {
  for (const width of [1440, 1536, 1920]) {
    test(
      `the On this page rail never covers the form at ${width} px`,
      { tag: "@desktop-only" },
      async ({ frigateApp }) => {
        const { page } = frigateApp;
        await page.setViewportSize({ width, height: 900 });
        await openSettings(page, "globalRecording");

        const rail = page.getByTestId("settings-nav-rail");
        await expect(rail).toBeVisible();
        const form = page.locator(".config-form").first();
        await expect(form).toBeVisible();

        const railBox = await boxOf(rail);
        expect(intersects(railBox, await boxOf(form))).toBe(false);
        // every field group card, including the widest ones
        const anchors = page.locator("[data-settings-anchor]:visible");
        expect(await anchors.count()).toBeGreaterThan(0);
        for (const anchor of await anchors.all()) {
          expect(intersects(railBox, await boxOf(anchor))).toBe(false);
        }
        // and it stays inside the window
        expect(railBox.x + railBox.width).toBeLessThanOrEqual(width);
      },
    );
  }

  test(
    "the rail hides when there is no room beside the form",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSettings(page, "globalRecording");
      await expect(page.locator(".config-form").first()).toBeVisible();
      await expect(page.getByTestId("settings-nav-rail")).toBeHidden();
    },
  );

  test(
    "phones never show the rail @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "globalRecording");
      await expect(page.locator(".config-form").first()).toBeVisible();
      await expect(page.getByTestId("settings-nav-rail")).toHaveCount(0);
    },
  );
});

test.describe("Users load error (UI103) @high @mobile", () => {
  test.use({
    expectedErrors: [
      /Failed to load resource.*(403|500)|(403|500).*\/api\/users/,
    ],
  });

  test("a 403 says only admins can manage users", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await page.route("**/api/users", (route) =>
      route.fulfill({
        status: 403,
        json: { success: false, message: "Mocked error" },
      }),
    );
    await openSettings(page, "users");

    const state = page.getByTestId("fork-error-state");
    await expect(state).toBeVisible({ timeout: 10_000 });
    await expect(state).toContainText("Could not load users");
    await expect(state).toContainText("Only admins can view and manage users");
    await expect(state).toContainText("HTTP 403");
    await expect(state.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("a 500 shows the generic message and Retry recovers", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let recovered = false;
    await page.route("**/api/users", (route) =>
      recovered
        ? route.fulfill({ json: [{ username: "admin", role: "admin" }] })
        : route.fulfill({
            status: 500,
            json: { success: false, message: "database locked" },
          }),
    );
    await openSettings(page, "users");

    const state = page.getByTestId("fork-error-state");
    await expect(state).toBeVisible({ timeout: 10_000 });
    await expect(state).toContainText("Could not load users");
    await expect(state).toContainText("did not return a valid response");
    await expect(state).toContainText("database locked");
    await expect(state).not.toContainText("Only admins");
    // the page shows the error itself, so no read-error toast on top
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

    recovered = true;
    await state.getByRole("button", { name: "Retry" }).click();
    await expect(state).toBeHidden();
    await expect(
      page.getByRole("cell", { name: "admin" }).first(),
    ).toBeVisible();
  });
});

test.describe("Triggers prerequisite (UI104) @medium", () => {
  test(
    "a neutral notice links to the semantic search settings",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "triggers");

      const notice = page.getByRole("region", {
        name: "Triggers need semantic search",
      });
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute(
        "data-testid",
        "triggers-semantic-search-notice",
      );
      await expect(notice).toContainText("Triggers need semantic search");
      await expect(page.getByText("Semantic Search is disabled")).toHaveCount(
        0,
      );
      await expect(
        notice.getByRole("link", { name: /Read the documentation/ }),
      ).toBeVisible();

      await notice
        .getByRole("button", { name: "Open semantic search settings" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Semantic Search", exact: true }),
      ).toBeVisible();
    },
  );
});

test.describe("Generative AI empty state (UI105) @medium", () => {
  test(
    "no providers shows guidance, and Add provider adds one",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "integrationGenerativeAi");

      const empty = page.getByTestId("config-empty-state");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No providers yet");
      await expect(empty).toContainText("llama.cpp");
      // nothing saved and nothing edited: no Save / Reset bar
      await expect(
        page.getByRole("button", { name: "Reset to Default" }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

      await empty.getByRole("button", { name: "Add provider" }).click();
      await expect(empty).toBeHidden();
      await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toBeVisible();

      // undo brings the empty state back without a Save / Reset bar
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("config-empty-state")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Reset to Default" }),
      ).toHaveCount(0);
    },
  );
});

test.describe("Camera management (UI111) @medium", () => {
  test(
    "delete is a row action and the states have a short legend",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "cameraManagement");

      await expect(
        page.getByRole("button", { name: "Add New Camera" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Clone settings" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete Camera", exact: true }),
      ).toHaveCount(0);

      const table = page.getByTestId("camera-state-table");
      await expect(
        table.getByRole("columnheader", { name: "State" }),
      ).toBeVisible();
      await expect(table.getByTestId("camera-row-delete")).toHaveCount(3);
      await expect(page.getByTestId("camera-state-legend")).toContainText(
        "pauses processing until Frigate restarts",
      );

      await table.getByRole("button", { name: "Delete Front Door" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("front_door");
      await expect(
        dialog.getByRole("button", { name: "Delete Permanently" }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    },
  );
});

test.describe("Media sync (UI112) @medium", () => {
  test(
    "type switches stay live and the start button names the run",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "mediaSync");

      await expect(page.getByTestId("media-sync-status")).toBeVisible();
      const start = page.getByRole("button", { name: "Start dry run" });
      await expect(start).toBeVisible();

      const exportsSwitch = page.getByRole("switch", { name: "Exports" });
      await expect(exportsSwitch).toBeEnabled();
      await exportsSwitch.click();
      await expect(exportsSwitch).not.toBeChecked();
      await expect(
        page.getByRole("switch", { name: "All Media" }),
      ).not.toBeChecked();
      await expect(
        page.getByRole("switch", { name: "Recordings" }),
      ).toBeChecked();

      await page.getByRole("switch", { name: "Dry Run" }).click();
      await expect(
        page.getByRole("button", { name: "Start Sync" }),
      ).toBeVisible();
      await expect(page.getByTestId("media-sync-start-hint")).toContainText(
        "will be deleted",
      );

      await page.getByRole("switch", { name: "All Media" }).click();
      await page.getByRole("switch", { name: "All Media" }).click();
      await expect(
        page.getByRole("button", { name: "Start Sync" }),
      ).toBeDisabled();
      await expect(page.getByTestId("media-sync-start-hint")).toContainText(
        "Choose at least one media type",
      );
    },
  );
});

test.describe("Frigate+ status (UI113) @medium", () => {
  test(
    "no key reads as not connected with how to connect",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "frigateplus");

      await expect(page.getByText("Not connected")).toBeVisible();
      await expect(page.getByTestId("plus-key-help")).toContainText(
        "PLUS_API_KEY",
      );
      const pills = page.locator('[data-testid="status-pill"]');
      await expect(pills).toHaveCount(4);
      await expect(page.locator(".text-danger, .text-red-500")).toHaveCount(0);

      await page
        .getByRole("button", { name: "Open snapshot settings" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Snapshots", exact: true }),
      ).toBeVisible();
    },
  );
});

test.describe("Notifications register hint (UI114) @medium", () => {
  test(
    "a disabled Register button says why",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "notifications");

      await expect(
        page.getByRole("button", { name: "Register This Device" }),
      ).toBeDisabled();
      await expect(page.getByTestId("register-device-hint")).toContainText(
        "at least one camera",
      );

      await page.getByRole("switch", { name: "Front Door" }).click();
      await expect(page.getByTestId("register-device-hint")).toContainText(
        "Save your notification settings first",
      );
    },
  );
});

test.describe("Profiles explainer (UI115) @medium", () => {
  test(
    "the empty Profiles page explains how profiles work",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await openSettings(page, "profiles");

      const how = page.getByTestId("profiles-how-it-works");
      await expect(how).toBeVisible();
      await expect(how.getByRole("listitem")).toHaveCount(3);
      await expect(how).toContainText("without a restart");
    },
  );
});

test.describe("Settings page headers line up (UI113) @medium", () => {
  test(
    "UI settings, Media sync and Frigate+ titles sit where config form titles do",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const titleBox = async (settingsPage: string, title: string) => {
        await openSettings(page, settingsPage);
        const heading = page
          .locator("#pageRoot")
          .getByRole("heading", { level: 4, name: title, exact: true });
        await expect(heading).toBeVisible();
        return boxOf(heading);
      };

      const reference = await titleBox("globalRecording", "Recording");
      for (const [settingsPage, title] of [
        ["uiSettings", "UI Settings"],
        ["mediaSync", "Media Sync"],
        ["frigateplus", "Frigate+ Settings"],
      ] as const) {
        const box = await titleBox(settingsPage, title);
        expect(Math.abs(box.x - reference.x), settingsPage).toBeLessThanOrEqual(
          1,
        );
        expect(Math.abs(box.y - reference.y), settingsPage).toBeLessThanOrEqual(
          1,
        );
      }
    },
  );
});
