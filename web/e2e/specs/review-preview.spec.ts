import { test, expect } from "../fixtures/frigate-test";

const thumbnail = "/clips/review/hover-test.webp";

async function installReview(
  app: import("../fixtures/frigate-test").FrigateApp,
) {
  const now = Math.floor(Date.now() / 1000);
  await app.installDefaults({
    reviews: [
      {
        id: "hover-test",
        camera: "front_door",
        severity: "alert",
        start_time: now,
        end_time: now + 5,
        has_been_reviewed: false,
        thumb_path: `/media/frigate${thumbnail}`,
        data: {
          objects: ["person"],
          audio: [],
          detections: [],
          zones: [],
          sub_labels: [],
        },
      },
    ],
  });
  await app.goto("/review");
  const card = app.page
    .getByRole("button", { name: /Preview from front_door/ })
    .first();
  await expect(card).toBeVisible();
  return card;
}

test.describe("Review hover preview @critical @desktop-only", () => {
  test("keeps the thumbnail when preview frames are unavailable", async ({
    frigateApp,
  }) => {
    const card = await installReview(frigateApp);
    const frames = frigateApp.page.waitForResponse(
      /\/api\/preview\/.*\/frames/,
    );
    await card.hover();
    await frames;
    await expect
      .poll(() =>
        card
          .locator("img")
          .evaluateAll((images) =>
            images.some(
              (image) =>
                image instanceof HTMLImageElement &&
                image.complete &&
                image.naturalWidth > 0 &&
                getComputedStyle(image).opacity !== "0" &&
                !!image.getAttribute("src"),
            ),
          ),
      )
      .toBe(true);
    await expect(card.locator("img:not([src])")).toHaveCount(0);
  });
});

test("Review thumbnail remains usable on touch @critical @mobile-only", async ({
  frigateApp,
}) => {
  const card = await installReview(frigateApp);
  await expect(card.locator("img")).toHaveAttribute(
    "src",
    new RegExp(thumbnail),
  );
  await expect
    .poll(() =>
      card
        .locator("img")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
});

test("Review hover advances through decoded frames @critical @desktop-only", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  const card = await installReview(frigateApp);
  await page.route("**/api/preview/**/frames", (route) =>
    route.fulfill({ json: ["frame-1", "frame-2", "frame-3"] }),
  );
  await page.route("**/api/preview/frame-*/thumbnail.webp", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="green"/></svg>',
    }),
  );
  await page.route("**/api/reviews/viewed", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await card.hover();
  const preview = card.locator('img[src*="frame-3"]');
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(320);
  await page.mouse.move(0, 0);
  await expect(card.locator('img[src*="frame-"]')).toHaveCount(0);
});
