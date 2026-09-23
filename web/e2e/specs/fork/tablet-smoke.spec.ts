/** Narrow desktop shell navigation at a touch tablet viewport. */
import { expect, test } from "../../fixtures/frigate-test";

test("tablet rail reaches Review without clipping the page @tablet-only", async ({
  frigateApp,
}) => {
  await frigateApp.goto("/");
  const page = frigateApp.page;
  await expect(page.locator("aside")).toBeVisible();
  await page
    .getByRole("link", { name: /Review/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.locator("#pageRoot")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(820);
});
