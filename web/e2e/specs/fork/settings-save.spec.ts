/**
 * D2: Settings save path. Edit a field, unsaved indicator, Save All body,
 * restart-required notice. Navigation coverage is in settings-nav.spec.ts.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";

const SEMANTIC_URL = "/settings?page=integrationSemanticSearch";

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
  test.describe("desktop", () => {
    test.skip(
      ({ frigateApp }) => frigateApp.isMobile,
      "Desktop Save All header flow",
    );
    test("Save All sends the semantic-search body and the restart notice", async ({
      frigateApp,
    }) => {
      const { saved } = await installSettingsConfigRoutes(
        frigateApp.page,
        true,
      );
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
  });

  test.describe("mobile", () => {
    test.skip(
      ({ frigateApp }) => !frigateApp.isMobile,
      "Mobile unsaved banner",
    );
    test("unsaved indicator appears after a field edit @mobile", async ({
      frigateApp,
    }) => {
      await installSettingsConfigRoutes(frigateApp.page, false);
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
});
