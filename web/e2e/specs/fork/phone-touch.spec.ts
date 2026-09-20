/**
 * Fork: phone touch targets and layout (UI100).
 *
 * A 412 px Android phone: bottom bar entries and the shared Button are at
 * least 44 px, the System header no longer draws over its title, Explore
 * thumbnails stay inside their cards, and the camera settings cog is named
 * after the camera.
 */

import { test, expect } from "../../fixtures/frigate-test";

test.describe("Phone touch targets @high @mobile", () => {
  test(
    "bottom bar entries are 48 px targets in portrait",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      const live = frigateApp.page.getByRole("link", {
        name: "Live",
        exact: true,
      });
      await expect
        .poll(async () => (await live.boundingBox())?.width)
        .toBeGreaterThanOrEqual(48);
      const settings = frigateApp.page.getByRole("button", {
        name: "Settings",
        exact: true,
      });
      const box = await settings.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(48);
      expect(box?.height).toBeGreaterThanOrEqual(48);
    },
  );

  test(
    "page buttons are at least 44 px tall",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/review");
      const filters = frigateApp.page
        .getByRole("button", { name: "Filters" })
        .first();
      await expect(filters).toBeVisible();
      expect((await filters.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    },
  );

  test(
    "System header does not draw over the page title",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/system");
      const { page } = frigateApp;
      const share = page.getByRole("button", {
        name: "Copy link to this view",
      });
      const title = page.getByText("System", { exact: true }).first();
      await expect(share).toBeVisible();
      const shareBox = await share.boundingBox();
      const titleBox = await title.boundingBox();
      expect(shareBox && titleBox).toBeTruthy();
      expect(shareBox!.y + shareBox!.height).toBeLessThanOrEqual(titleBox!.y);
      // the open tab is named, the others stay icons
      await expect(
        page.getByRole("radio", { name: "Select General" }),
      ).toContainText("General");
    },
  );

  test(
    "Explore thumbnails stay inside their card",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/explore");
      // UI119: the tile is 16:9 now, so the frame arrives uncropped
      const thumb = frigateApp.page.locator(".aspect-video img").first();
      await expect(thumb).toBeVisible();
      const offset = await thumb.evaluate((img) => {
        const cell = img.closest(".aspect-video")!.getBoundingClientRect();
        return Math.round(img.getBoundingClientRect().top - cell.top);
      });
      expect(offset).toBe(0);
    },
  );

  test(
    "camera settings cog is named after the camera",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/#front_door");
      const cog = frigateApp.page.getByRole("button", {
        name: /Front Door Settings/i,
      });
      await expect(cog.first()).toBeVisible({ timeout: 10_000 });
      await expect(
        frigateApp.page.getByRole("button", { name: /object Object/ }),
      ).toHaveCount(0);
    },
  );

  test(
    "a settings panel opens without the slide under reduced motion",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await frigateApp.goto("/settings");
      await page
        .getByRole("button", { name: "UI settings", exact: true })
        .click();
      const back = page.getByRole("button", { name: "Go back" });
      // in place at once: no frame where the panel is still off to the right
      await expect(back).toBeInViewport({ timeout: 1_000 });
      await back.click();
      await expect(
        page.getByRole("heading", { level: 2, name: "Settings" }),
      ).toBeVisible();
    },
  );
});
