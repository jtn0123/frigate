import { test, expect } from "../../fixtures/frigate-test";

test.describe("Recording stream quality (B17) @high @mobile", () => {
  test("allows original, low and automatic quality on desktop and mobile", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    await frigateApp.installDefaults({
      config: {
        cameras: {
          front_door: { record: { enabled: true, sub: { enabled: true } } },
        },
      },
    });
    await page.route("**/api/*/recordings/coverage**", (route) =>
      route.fulfill({
        json: {
          spans: [],
          codecs_compatible: true,
          streams: {
            main: { video_codec: "h264", has_audio: false },
            sub: { video_codec: "h264", has_audio: false },
          },
          timelines: { auto: [], main: [], sub: [] },
        },
      }),
    );
    await frigateApp.goto(
      `/review?timestamp=front_door_${Math.floor(Date.now() / 1000) - 300}`,
    );
    if (frigateApp.isMobile) {
      const filters = page.getByRole("button", { name: /filters/i }).first();
      const quality = page.getByRole("button", {
        name: "Quality",
        exact: true,
      });
      // The review page re-renders into the recording view after it loads,
      // so an early tap can land on a Filters button that is then replaced
      // and the drawer never opens. Tap again until Quality is shown (D81).
      const openQuality = async () => {
        await expect(async () => {
          if (!(await quality.isVisible())) {
            await filters.click({ timeout: 2_000 });
          }
          await expect(quality).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 15_000 });
        await quality.click();
      };
      await openQuality();
      for (const name of ["Low", "Original", "Auto"]) {
        const option = page.getByRole("button", {
          name: new RegExp(`^${name}`),
        });
        await option.click();
        // Choosing quality closes the drawer and applies the preference.
        await openQuality();
        await expect(option).toHaveAttribute("aria-pressed", "true");
      }
    } else {
      for (const name of ["Low", "Original", "Auto"]) {
        await page
          .getByRole("button", { name: "Quality", exact: true })
          .click();
        const option = page.getByRole("menuitemradio", {
          name: new RegExp(`^${name}`),
        });
        await option.click();
        await page
          .getByRole("button", { name: "Quality", exact: true })
          .click();
        await expect(option).toHaveAttribute("aria-checked", "true");
        await page.keyboard.press("Escape");
      }
    }
  });
});
