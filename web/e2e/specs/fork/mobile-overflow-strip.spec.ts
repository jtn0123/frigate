/**
 * UI149 (upstream #24543): on a phone the System tabs stay on one line and
 * the ones that do not fit sit behind a kebab, as the camera groups on Live
 * already did. The selected tab or group always stays in the strip.
 */

import { test, expect } from "../../fixtures/frigate-test";

// narrow enough that the System tabs and the groups below overflow
const NARROW = { width: 320, height: 720 };

test.describe("Mobile overflow strip @high", () => {
  test(
    "System tabs overflow behind a kebab and the picked tab stays visible",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.setViewportSize(NARROW);
      await frigateApp.goto("/system#general");

      const general = page.getByRole("radio", { name: "Select General" });
      await expect(general).toHaveAttribute("aria-checked", "true", {
        timeout: 15_000,
      });
      const kebab = page.getByRole("button", { name: "Show all tabs" });
      await expect(kebab).toBeVisible();

      // Cameras is the last tab, so it starts past the cut
      const cameras = page.getByRole("radio", { name: "Select Cameras" });
      await expect(cameras).toHaveCount(0);

      await kebab.click();
      await expect(kebab).toHaveAttribute("aria-expanded", "true");
      await cameras.last().click();

      await expect(page).toHaveURL(/#cameras$/);
      await expect(page.getByRole("button", { name: "Show less" })).toHaveCount(
        0,
      );
      await expect(cameras).toHaveCount(1);
      await expect(cameras).toBeVisible();
      await expect(cameras).toHaveAttribute("aria-checked", "true");
    },
  );

  test(
    "System tabs need no kebab on a desktop",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/system#general");
      await expect(
        page.getByRole("radio", { name: "Select General" }),
      ).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
      await expect(
        page.getByRole("radio", { name: "Select Cameras" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Show all tabs" }),
      ).toHaveCount(0);
    },
  );

  test(
    "a camera group picked from the panel stays in the strip",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const groups: Record<
        string,
        { cameras: string[]; icon: string; order: number }
      > = {};
      for (let i = 1; i <= 8; i++) {
        groups[`group_${i}`] = {
          cameras: ["front_door"],
          icon: "LuCar",
          order: i,
        };
      }
      await frigateApp.installDefaults({ config: { camera_groups: groups } });
      await page.setViewportSize(NARROW);
      await frigateApp.goto("/");

      const kebab = page.getByRole("button", {
        name: "Show all camera groups",
      });
      await expect(kebab).toBeVisible({ timeout: 10_000 });
      const last = page.getByRole("button", { name: "group 8", exact: true });
      await expect(last).toHaveCount(0);

      await kebab.click();
      await last.last().click();

      await expect(page.getByRole("button", { name: "Show less" })).toHaveCount(
        0,
      );
      await expect(last).toHaveCount(1);
      await expect(last).toBeVisible();
      await expect(last).toHaveClass(/text-selected/);
    },
  );
});
