/**
 * Settings views that own the page's "unsaved changes" flag must set it while
 * an edit is open and clear it once the edit is saved, reverted or has
 * failed; otherwise leaving Settings either loses work without a prompt or
 * asks about changes that no longer exist.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";

async function recordConfigSet(page: Page) {
  const saved: string[] = [];
  await page.route("**/api/config/set**", async (route) => {
    saved.push(route.request().url());
    await route.fulfill({ json: { success: true } });
  });
  return saved;
}

/** Record (and dismiss) every confirm prompt the page raises. */
function recordPrompts(page: Page) {
  const prompts: string[] = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.type());
    void dialog.dismiss();
  });
  return prompts;
}

async function clickExport(page: Page) {
  await page.getByRole("link", { name: "Export", exact: true }).first().click();
}

test.describe("Motion tuner unsaved changes @high", () => {
  test("saving the tuner lets you leave without a prompt @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const saved = await recordConfigSet(page);
    await frigateApp.goto("/settings?page=motionTuner");
    await page.locator("#improve-contrast").click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toContain("motion.improve_contrast=");

    const prompts = recordPrompts(page);
    await clickExport(page);
    await expect(page).toHaveURL(/\/export$/);
    expect(prompts).toEqual([]);
  });

  test("resetting the tuner lets you leave without a prompt", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await recordConfigSet(page);
    await frigateApp.goto("/settings?page=motionTuner");
    await page.locator("#improve-contrast").click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();

    const prompts = recordPrompts(page);
    await clickExport(page);
    await expect(page).toHaveURL(/\/export$/);
    expect(prompts).toEqual([]);
  });
});
