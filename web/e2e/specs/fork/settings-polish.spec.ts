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
