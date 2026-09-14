import { expect, test } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";
import { toggleSemanticSearchAndOpenSaveAll } from "../../helpers/settings-save-flow";

test.describe("failed saves @desktop-only @high", () => {
  test.use({
    expectedErrors: [
      /500.*\/api\/config\/set|Failed to load resource.*500|Save All.*error saving semantic_search.*500/,
    ],
  });

  test("failed Save All retains pending edits and exit protection", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await installSettingsConfigRoutes(page);
    await page.route("**/api/config/set", (route) =>
      route.fulfill({ status: 500, json: { success: false } }),
    );
    await frigateApp.goto("/settings?page=integrationSemanticSearch");
    const { dialog, saveAll } = await toggleSemanticSearchAndOpenSaveAll(page);
    await dialog.getByRole("button", { name: "Save All" }).click();
    await expect(page.getByText("Failed to save all sections.")).toBeVisible();
    await expect(saveAll).toBeEnabled();
    const handled = new Promise<string>((resolve) => {
      page.once("dialog", async (prompt) => {
        await prompt.dismiss();
        resolve(prompt.message());
      });
    });
    await page
      .getByRole("link", { name: "Export", exact: true })
      .first()
      .click();
    expect(await handled).toContain("unsaved");
    await expect(page).toHaveURL(/\/settings/);
    await saveAll.click();
    await expect(dialog).toContainText("Semantic search");
  });
});

test("clipboard failure offers the exact view address using keyboard navigation @high @mobile", async ({
  frigateApp,
}, testInfo) => {
  const { page } = frigateApp;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () => Promise.reject(new Error("Permission denied")),
      },
    });
    localStorage.setItem(
      "frigate-ui-theme",
      JSON.stringify({ theme: "dark", colorScheme: "theme-default" }),
    );
  });
  const label =
    "Copy the complete address to share this selected camera health view";
  await page.route("**/locales/en/fork.json*", async (route) => {
    const response = await route.fetch();
    const locale = await response.json();
    locale.navigation.copyView = label;
    await route.fulfill({ json: locale });
  });
  await frigateApp.goto("/system?camera=front_door#health");
  const copy = page.getByRole("button", { name: label });
  await copy.focus();
  await expect(copy).toBeFocused();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(
    await copy.evaluate(
      (button) => button.getBoundingClientRect().right <= window.innerWidth,
    ),
  ).toBe(true);
  const handled = new Promise<string>((resolve) => {
    page.once("dialog", async (prompt) => {
      const address = prompt.defaultValue();
      await prompt.dismiss();
      resolve(address);
    });
  });
  await page.keyboard.press("Enter");
  expect(await handled).toBe(page.url());
  await expect(copy).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("navigation-dark.png") });
});
