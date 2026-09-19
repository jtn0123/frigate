/**
 * The desktop status bar lists its warnings behind one chip (UI110): open it
 * to read them. Returns the popover list.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export async function openStatusIssues(page: Page): Promise<Locator> {
  const chip = page.getByTestId("status-issues-chip");
  const list = page.getByTestId("status-issues-list");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  if ((await chip.getAttribute("aria-expanded")) !== "true") {
    await chip.click();
  }
  await expect(list).toBeVisible();
  return list;
}
