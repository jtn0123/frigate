import { expect, test } from "../../fixtures/frigate-test";

test("fullscreen remains usable when screen wake permission is denied @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: () =>
          Promise.reject(
            new DOMException("Wake lock denied", "NotAllowedError"),
          ),
      },
    });
  });
  await frigateApp.goto("/#front_door");
  const fullscreenButton = page.locator('[aria-label="Fullscreen"]').first();
  await expect(fullscreenButton).toBeVisible();
  await fullscreenButton.click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement !== null))
    .toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBeNull();
  // Leaving fullscreen brings the control back, ready to enter again.
  await expect(fullscreenButton).toBeVisible();
});
