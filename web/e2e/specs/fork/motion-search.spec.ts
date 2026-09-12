/**
 * D2: Motion search from Review. Empty state, draw a region, run, results.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";

const playbackTime = Math.floor(Date.now() / 1000) - 300;

async function mockRecordingApis(page: Page) {
  const searches: unknown[] = [];
  await page.route("**/api/*/recordings**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/recordings/unavailable**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/*/recordings/coverage**", (route) =>
    route.fulfill({
      json: {
        spans: [
          {
            start_time: playbackTime - 3600,
            end_time: playbackTime + 600,
            streams: ["main"],
          },
        ],
        codecs_compatible: true,
        streams: {
          main: {
            video_codec: "h264",
            audio_rate: null,
            audio_codec: null,
            has_audio: false,
            bitrate: 2_000_000,
          },
        },
      },
    }),
  );
  await page.route("**/api/**/search/motion**", async (route) => {
    if (route.request().method() === "POST") {
      searches.push(route.request().postDataJSON());
      await route.fulfill({
        json: { success: true, job_id: "job-motion-1" },
      });
      return;
    }
    await route.fulfill({ json: { success: true } });
  });
  return { searches };
}

async function openMotionSearch(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page
      .getByRole("button", { name: /filters|camera options/i })
      .first()
      .click({ timeout: 15_000 });
    await page.getByRole("button", { name: /^Motion Search$/i }).click();
  } else {
    await page.getByRole("button", { name: /actions/i }).click({
      timeout: 15_000,
    });
    await page.getByRole("menuitem", { name: /^Motion Search$/i }).click();
  }

  await expect(page.getByRole("button", { name: /Start Search/i })).toBeVisible(
    { timeout: 10_000 },
  );
}

test.describe("Motion search @high", () => {
  test.describe("desktop", () => {
    // Skip on phone: Motion Search opens from the desktop actions menu.
    test.skip(
      ({ frigateApp }) => frigateApp.isMobile,
      "Desktop actions menu and canvas",
    );
    test("empty state and Start Search stay disabled until a region is drawn", async ({
      frigateApp,
    }) => {
      await mockRecordingApis(frigateApp.page);
      await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);
      await openMotionSearch(frigateApp.page, false);
      await expect(
        frigateApp.page.getByRole("button", { name: /Start Search/i }),
      ).toBeDisabled();
    });

    test("drawing on the canvas records region points", async ({
      frigateApp,
    }) => {
      await mockRecordingApis(frigateApp.page);
      await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);
      await openMotionSearch(frigateApp.page, false);

      const canvas = frigateApp.page.locator("canvas").first();
      await expect(canvas).toBeVisible({ timeout: 10_000 });
      const box = await canvas.boundingBox();
      expect(box).toBeTruthy();
      const size = box as { width: number; height: number };
      await canvas.click({
        position: { x: size.width * 0.25, y: size.height * 0.25 },
      });
      await canvas.click({
        position: { x: size.width * 0.75, y: size.height * 0.25 },
      });
      await canvas.click({
        position: { x: size.width * 0.5, y: size.height * 0.75 },
      });

      await expect(frigateApp.page.getByText(/[3-9] points/)).toBeVisible();
      await expect(
        frigateApp.page.getByRole("button", { name: /Start Search/i }),
      ).toBeDisabled();
    });
  });

  test.describe("mobile", () => {
    // Skip on desktop: Motion Search opens from the mobile camera drawer.
    test.skip(({ frigateApp }) => !frigateApp.isMobile, "Mobile drawer");
    test("opens from the mobile camera menu @mobile", async ({
      frigateApp,
    }) => {
      await mockRecordingApis(frigateApp.page);
      await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);
      await openMotionSearch(frigateApp.page, true);
      await expect(
        frigateApp.page.getByRole("button", { name: /Start Search/i }),
      ).toBeDisabled();
    });
  });
});
