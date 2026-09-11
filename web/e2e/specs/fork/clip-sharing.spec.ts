/**
 * Fork: expiring clip share link + QR (UI item 11).
 *
 * Explore's detail dialog exposes Share; the public /share/:token page
 * plays the clip without a login.
 */

import { test, expect } from "../../fixtures/frigate-test";

const SHARE_BODY = {
  token: "e2eShareToken123456789012345678",
  url: "/share/e2eShareToken123456789012345678",
  expires_at: Date.now() / 1000 + 3600,
  event_id: "event-person-001",
  camera: "front_door",
  label: "person",
  start_time: 1780677009,
  end_time: 1780677039,
  has_clip: true,
};

test.describe("Clip sharing @high", () => {
  test("Explore detail can create a share link with a QR code", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.route("**/api/fork/share", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ json: SHARE_BODY });
      }
      return route.fallback();
    });

    await frigateApp.goto("/explore?labels=person");
    await page.locator('img[src*="/thumbnail.webp"]').first().click();
    const share = page.getByTestId("share-clip");
    await expect(share).toBeVisible({ timeout: 10_000 });
    await share.click();
    await expect(page.getByTestId("share-clip-dialog")).toBeVisible();
    await expect(page.getByTestId("share-clip-url")).toHaveValue(
      /\/share\/e2eShareToken/,
    );
    await expect(
      page.getByTestId("share-clip-qr").locator("svg"),
    ).toBeVisible();
  });

  test("public share page shows the clip metadata and QR @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.route(
      "**/api/fork/share/e2eShareToken123456789012345678",
      (route) => {
        if (route.request().method() === "GET") {
          return route.fulfill({ json: SHARE_BODY });
        }
        return route.fallback();
      },
    );
    await page.route(
      "**/api/fork/share/e2eShareToken123456789012345678/clip.mp4",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "video/mp4",
          body: "",
        }),
    );

    await frigateApp.goto("/share/e2eShareToken123456789012345678");
    const root = page.getByTestId("share-clip-page");
    await expect(root).toBeVisible({ timeout: 10_000 });
    await expect(root).toContainText(/person/i);
    await expect(root).toContainText(/front_door/i);
    await expect(
      page.getByTestId("share-clip-qr").locator("svg"),
    ).toBeVisible();
  });
});
