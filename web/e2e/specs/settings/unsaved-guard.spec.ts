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

test.describe("Trigger unsaved changes @high", () => {
  // The desktop table labels its delete button; the phone list shows an icon only.
  test.skip(({ frigateApp }) => frigateApp.isMobile, "Desktop trigger table");

  test("a failed trigger delete lets you leave without a prompt", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: {
        semantic_search: { enabled: true },
        cameras: {
          front_door: {
            semantic_search: {
              triggers: {
                doorbell: {
                  enabled: true,
                  type: "description",
                  data: "person at the door",
                  threshold: 0.8,
                  actions: [],
                  friendly_name: "",
                },
              },
            },
          },
        },
      },
    });
    const deletes: string[] = [];
    await page.route("**/api/trigger/embedding/**", async (route) => {
      deletes.push(route.request().method());
      await route.fulfill({
        status: 500,
        json: { success: false, message: "Mocked error" },
      });
    });
    await frigateApp.goto("/settings?page=triggers&camera=front_door");
    await page.getByRole("button", { name: "Delete Trigger" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => deletes.length).toBe(1);
    expect(deletes).toEqual(["DELETE"]);
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeHidden();

    const prompts = recordPrompts(page);
    await clickExport(page);
    await expect(page).toHaveURL(/\/export$/);
    expect(prompts).toEqual([]);
  });
});
