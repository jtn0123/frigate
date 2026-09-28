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
      await page
        .getByRole("button", { name: /filters/i })
        .first()
        .click();
      await page.getByRole("button", { name: "Quality", exact: true }).click();
      for (const name of ["Low", "Original", "Auto"]) {
        const option = page.getByRole("button", {
          name: new RegExp(`^${name}`),
        });
        await option.click();
        // Choosing quality closes the drawer and applies the preference.
        await page
          .getByRole("button", { name: /filters/i })
          .first()
          .click();
        await page
          .getByRole("button", { name: "Quality", exact: true })
          .click();
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
