/**
 * Fork: appearance controls (UI item 15).
 *
 * Density, text size and OLED black live in the settings menu and are
 * applied to <html> as data-density, --fork-font-scale and the .oled class,
 * persisted in localStorage.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";

async function openAppearanceMenu(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  // Desktop: sidebar gear dropdown. Mobile: the bottombar's settings drawer
  // trigger (vaul renders the trigger as a <button>).
  const gear = frigateApp.isMobile
    ? page.locator(".absolute.inset-x-4.bottom-0 button").first()
    : page.locator("aside .mb-8 div[class*='cursor-pointer']").first();
  await gear.click();
  await page.getByTestId("fork-appearance-trigger").click();
  await expect(page.getByTestId("fork-appearance-menu")).toBeVisible();
}

test.describe("Appearance controls @high", () => {
  test("defaults are applied to the root element on load", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    const html = frigateApp.page.locator("html");
    await expect(html).toHaveAttribute("data-density", "comfortable");
    await expect(html).not.toHaveClass(/\boled\b/);
    const scale = await frigateApp.page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--fork-font-scale"),
    );
    expect(scale).toBe("1");
  });

  test(
    "switching density updates data-density and persists",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      await openAppearanceMenu(frigateApp);
      await frigateApp.page.getByTestId("fork-density-compact").click();

      const html = frigateApp.page.locator("html");
      await expect(html).toHaveAttribute("data-density", "compact");

      const stored = await frigateApp.page.evaluate(() =>
        JSON.parse(localStorage.getItem("frigate-fork-appearance") ?? "{}"),
      );
      expect(stored.density).toBe("compact");

      await frigateApp.page.reload();
      await frigateApp.page.waitForSelector("#pageRoot", { timeout: 10_000 });
      await expect(html).toHaveAttribute("data-density", "compact");
    },
  );

  test(
    "font scale sets --fork-font-scale on the root",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      await openAppearanceMenu(frigateApp);
      await frigateApp.page.getByTestId("fork-font-scale-larger").click();
      await expect
        .poll(() =>
          frigateApp.page.evaluate(() =>
            document.documentElement.style.getPropertyValue(
              "--fork-font-scale",
            ),
          ),
        )
        .toBe("1.25");
      await expect
        .poll(() =>
          frigateApp.page.evaluate(
            () => getComputedStyle(document.documentElement).fontSize,
          ),
        )
        .toBe("20px");
    },
  );

  test(
    "OLED switch toggles the oled class without closing the menu",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      await openAppearanceMenu(frigateApp);
      const toggle = frigateApp.page.getByTestId("fork-oled-switch");
      await toggle.click();
      await expect(frigateApp.page.locator("html")).toHaveClass(/\boled\b/);
      await expect(toggle).toHaveAttribute("data-state", "checked");
      await expect(
        frigateApp.page.getByTestId("fork-appearance-menu"),
      ).toBeVisible();
      await toggle.click();
      await expect(frigateApp.page.locator("html")).not.toHaveClass(/\boled\b/);
    },
  );

  test(
    "@mobile density toggle works from the bottom bar drawer",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      await openAppearanceMenu(frigateApp);
      await frigateApp.page.getByTestId("fork-density-compact").click();
      await expect(frigateApp.page.locator("html")).toHaveAttribute(
        "data-density",
        "compact",
      );
    },
  );
});
