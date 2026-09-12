/**
 * D2: Settings save path. Edit a field, unsaved indicator, Save All body,
 * restart-required notice. Navigation coverage is in settings-nav.spec.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_SCHEMA = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../fixtures/mock-data/config-schema.json"),
    "utf-8",
  ),
);

const SEMANTIC_URL = "/settings?page=integrationSemanticSearch";

async function installRoutes(page: Page, requireRestart: boolean) {
  const saved: unknown[] = [];
  await page.route("**/api/config/schema.json", (route) =>
    route.fulfill({ json: CONFIG_SCHEMA }),
  );
  await page.route("**/api/config/set", async (route) => {
    saved.push(route.request().postDataJSON());
    await route.fulfill({
      json: { success: true, require_restart: requireRestart },
    });
  });
  await page.route("**/api/config/raw_paths", (route) =>
    route.fulfill({ json: {} }),
  );
  return { saved };
}

async function changeSemanticSearchAndOpenSaveAll(page: Page) {
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

test.describe("Settings save @high", () => {
  test("Save All sends the semantic-search body and the restart notice", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop Save All header flow");
    const { saved } = await installRoutes(frigateApp.page, true);
    await frigateApp.goto(SEMANTIC_URL);
    const { page } = frigateApp;
    const { dialog } = await changeSemanticSearchAndOpenSaveAll(page);

    await dialog.getByRole("button", { name: "Save All" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({
      config_data: { semantic_search: { enabled: true } },
    });
    await expect(
      page.getByText(/Restart Frigate to apply your changes/).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Restart$/i }).first(),
    ).toBeVisible();
  });

  test("unsaved indicator appears after a field edit @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile unsaved banner");
    await installRoutes(frigateApp.page, false);
    await frigateApp.goto(SEMANTIC_URL);
    const enabled = frigateApp.page.getByRole("switch", {
      name: "Enable semantic search",
    });
    await expect(enabled).toBeVisible();
    await enabled.click();
    await expect(
      frigateApp.page.getByText("You have unsaved changes").first(),
    ).toBeVisible();
  });
});
