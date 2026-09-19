/**
 * On a phone the command palette opens from the Settings drawer: the bottom
 * bar has no room for its own button next to 48 px touch targets.
 */
import { expect, type Page } from "@playwright/test";

export async function openPaletteOnPhone(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const entry = page.getByTestId("command-palette-hint");
  await expect(entry).toHaveAttribute("aria-label", "Open command palette");
  await entry.click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
}
