/**
 * Fork: shared event summary header (UI item 9).
 *
 * Explore's tracked-object dialog and Review's detail stream both show
 * the same camera / label / time row.
 */

import { test, expect } from "../../fixtures/frigate-test";

test.describe("Event summary header @high", () => {
  test("Explore detail dialog shows camera and label", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/explore?labels=person");
    const { page } = frigateApp;
    await page.locator('img[src*="/thumbnail.webp"]').first().click();
    const header = page.getByTestId("event-summary-header");
    await expect(header).toBeVisible({ timeout: 10_000 });
    await expect(header).toContainText(/person/i);
    await expect(header).toContainText(/front door/i);
  });

  test("Review detail stream shows the same summary row", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop detail toggle");
    const { page } = frigateApp;
    await frigateApp.goto("/review");
    const cards = page.locator('.review-item [role="button"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    await cards.first().click();
    await expect(page).toHaveTitle(/Recordings/);
    await page.getByLabel("Detail Stream").click();
    const header = page.getByTestId("event-summary-header");
    await expect(header).toBeVisible({ timeout: 10_000 });
    await expect(header).toContainText(/person|front door/i);
  });
});
