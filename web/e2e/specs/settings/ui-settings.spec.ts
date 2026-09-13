/**
 * UI Settings (Live Dashboard) switches -- MEDIUM tier.
 *
 * UI44: each boolean setting renders two switches, one beside the label on
 * mobile and one in the control column from md up. The label's htmlFor
 * pointed at the mobile one, so on desktop clicking the title did nothing
 * and the visible switch had no accessible name.
 */

import { test, expect } from "../../fixtures/frigate-test";

const UI_SETTINGS_URL = "/settings?page=uiSettings";
const SETTING = "Always Show Camera Names";

test.describe("UI Settings switches @medium", () => {
  test(
    "clicking a setting's title toggles its visible switch",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto(UI_SETTINGS_URL);
      const { page } = frigateApp;

      const toggle = page.getByRole("switch", { name: SETTING });
      await expect(toggle).toBeVisible({ timeout: 10_000 });
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      await page.getByText(SETTING, { exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      await page.getByText(SETTING, { exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    },
  );

  test(
    "@mobile the switch beside the title is named and toggles from the title",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto(UI_SETTINGS_URL);
      const { page } = frigateApp;

      const toggle = page.getByRole("switch", { name: SETTING });
      await expect(toggle).toBeVisible({ timeout: 10_000 });
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      await page.getByText(SETTING, { exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    },
  );
});
