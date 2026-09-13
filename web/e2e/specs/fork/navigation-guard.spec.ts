import { expect, test } from "../../fixtures/frigate-test";
import { installSettingsConfigRoutes } from "../../helpers/settings-config-routes";

test("navigation protects unsaved settings and allows a deliberate exit @high @mobile", async ({
  frigateApp,
}) => {
  const { page } = frigateApp;
  await installSettingsConfigRoutes(page, false);
  await frigateApp.goto("/settings?page=integrationSemanticSearch");
  const enabled = page.getByRole("switch", { name: "Enable semantic search" });
  await expect(enabled).toBeVisible();
  await enabled.click();
  await expect(
    page.getByText("You have unsaved changes").first(),
  ).toBeVisible();
  const dismissed = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.dismiss();
      resolve();
    });
  });
  await page.getByRole("link", { name: "Export", exact: true }).first().click();
  await dismissed;
  await expect(page).toHaveURL(/\/settings/);
  await expect(enabled).toBeChecked();
  const accepted = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByRole("link", { name: "Export", exact: true }).first().click();
  await accepted;
  await expect(page).toHaveURL(/\/export$/);
});
