/**
 * Fork: Settings you can navigate (UI item 7).
 *
 * Search box that finds sections by title and fields in the open section,
 * the desktop scrollspy rail, the mobile section select and the review
 * dialog that Save All opens.
 */

import { test, expect } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";

const SEMANTIC_URL = "/settings?page=integrationSemanticSearch";

test.describe("Settings navigator @high", () => {
  test("search finds a section by title and jumps to it", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop search flow");
    await installSettingsConfigRoutes(frigateApp.page);
    await frigateApp.goto(SEMANTIC_URL);
    const { page } = frigateApp;

    const search = page.getByTestId("settings-nav-search");
    await expect(search).toBeVisible();
    await search.fill("record");
    const results = page.getByTestId("settings-nav-results");
    await expect(results).toBeVisible();
    await expect(
      results.locator('[data-section-key="globalRecording"]'),
    ).toBeVisible();
    await expect(
      results.locator('[data-section-key="globalDetect"]'),
    ).toHaveCount(0);

    await results.locator('[data-section-key="globalRecording"]').click();
    await expect(results).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Recording", exact: true }),
    ).toBeVisible();
  });

  test("search finds field labels in the open section and reveals the field", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop search flow");
    await installSettingsConfigRoutes(frigateApp.page);
    await frigateApp.goto(SEMANTIC_URL);
    const { page } = frigateApp;

    await expect(page.getByText("Model size", { exact: true })).toBeVisible();
    await page.getByTestId("settings-nav-search").fill("model size");
    const field = page.getByTestId("settings-nav-field").first();
    await expect(field).toContainText("Model size");
    await field.click();
    await expect(page.locator("[data-settings-nav-highlight]")).toBeVisible();
    await expect(page.locator("[data-settings-nav-highlight]")).toContainText(
      "Model size",
    );
  });

  test("scrollspy rail lists the field groups of the open section", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop rail only");
    await installSettingsConfigRoutes(frigateApp.page);
    await frigateApp.goto("/settings?page=globalDetect");
    const { page } = frigateApp;

    const rail = page.getByTestId("settings-nav-rail");
    await expect(rail).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Global Resolution" }),
    ).toBeVisible();

    await page.getByRole("button", { name: /Advanced Settings/ }).click();
    await expect(
      rail.getByRole("button", { name: "Global Tracking" }),
    ).toBeVisible();
    await expect(rail.locator("button[data-active='true']")).toHaveCount(1);

    await rail.getByRole("button", { name: "Global Tracking" }).click();
    await expect(page.locator("[data-settings-nav-highlight]")).toContainText(
      "Global Tracking",
    );
  });

  test("Save All shows a before-and-after diff and saves on confirm", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "Desktop Save All header flow");
    const { saved } = await installSettingsConfigRoutes(frigateApp.page);
    await frigateApp.goto(SEMANTIC_URL);
    const { page } = frigateApp;

    const enabled = page.getByRole("switch", {
      name: "Enable semantic search",
    });
    await expect(enabled).toBeVisible();
    await enabled.click();
    await expect(
      page.getByText("You have unsaved changes").first(),
    ).toBeVisible();

    // Save All only appears once a pending change lives outside the open page.
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
    const change = dialog.getByTestId("settings-review-change");
    await expect(change).toHaveCount(1);
    await expect(change).toContainText("enabled");
    await expect(change).toContainText("false");
    await expect(change).toContainText("true");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(saved).toHaveLength(0);

    await saveAll.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Save All" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({
      config_data: { semantic_search: { enabled: true } },
    });
  });

  test("compact select jumps between sections @mobile", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile select only");
    await installSettingsConfigRoutes(frigateApp.page);
    await frigateApp.goto(SEMANTIC_URL);
    const { page } = frigateApp;

    const select = page.getByTestId("settings-nav-select");
    await expect(select).toBeVisible();
    await expect(select).toContainText("Semantic search");
    await select.click();
    await page
      .getByRole("option", { name: "Recording", exact: true })
      .first()
      .click();
    await expect(select).toContainText("Recording");
    await expect(
      page.getByRole("heading", { name: "Recording", exact: true }).first(),
    ).toBeVisible();

    await page.getByTestId("settings-nav-search").fill("motion");
    const results = page.getByTestId("settings-nav-results");
    await expect(
      results.locator('[data-section-key="globalMotion"]'),
    ).toBeVisible();
  });
});
