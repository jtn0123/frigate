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

test("UI preferences wait for storage before accepting edits @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await page.addInitScript(() => {
    const originalGet = IDBObjectStore.prototype.get;
    const pending: (() => void)[] = [];
    let released = false;
    window.addEventListener("release-ui-preferences", () => {
      released = true;
      pending.splice(0).forEach((complete) => complete());
    });
    IDBObjectStore.prototype.get = function (key) {
      const request = originalGet.call(this, key);
      if (typeof key === "string" && key.startsWith("displayCameraNames")) {
        // Hold the real IndexedDB result until the test releases it. This
        // exposes clicks during preference hydration without timing sleeps.
        Object.defineProperty(request, "onsuccess", {
          set(handler: (event: Event) => void) {
            request.addEventListener("success", (event) => {
              const complete = () => handler.call(request, event);
              if (released) complete();
              else pending.push(complete);
            });
          },
        });
      }
      return request;
    };
  });
  await frigateApp.goto(UI_SETTINGS_URL);
  const toggle = page.getByRole("switch", { name: SETTING });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  await page.getByText(SETTING, { exact: true }).click();
  // UI118: the setting ships on, so a click held behind hydration leaves it on
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-ui-preferences")),
  );
  await expect(toggle).toBeEnabled();
  await page.getByText(SETTING, { exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test.describe("UI Settings switches @medium", () => {
  test(
    "clicking a setting's title toggles its visible switch",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto(UI_SETTINGS_URL);
      const { page } = frigateApp;

      const toggle = page.getByRole("switch", { name: SETTING });
      await expect(toggle).toBeVisible({ timeout: 10_000 });
      // UI118: the setting ships on
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(toggle).toBeEnabled();

      await page.getByText(SETTING, { exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");

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
      // UI118: the setting ships on
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(toggle).toBeEnabled();

      await page.getByText(SETTING, { exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    },
  );
});
