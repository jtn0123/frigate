/**
 * Shared Settings UI steps for the Save All dialog.
 *
 * settings-nav asserts the diff; settings-save asserts the POST body and
 * restart notice. The click path was a 19-line Sonar clone.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export async function toggleSemanticSearchAndOpenSaveAll(page: Page) {
  const enabled = page.getByRole("switch", {
    name: "Enable semantic search",
  });
  await expect(enabled).toBeVisible();
  await enabled.click();
  await expect(
    page.getByText("You have unsaved changes").first(),
  ).toBeVisible();

  await page.getByTestId("settings-nav-search").fill("object detection");
  await page
    .getByTestId("settings-nav-results")
    .locator('[data-section-key="globalDetect"]')
    .click();
  const saveAll = page.getByRole("button", { name: "Save All", exact: true });
  await expect(saveAll).toBeVisible();
  await saveAll.click();
  const dialog = page.getByTestId("settings-review-dialog");
  await expect(dialog).toBeVisible();
  return { saveAll, dialog };
}
