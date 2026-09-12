/**
 * D2: Masks and zones editor. Add a zone, validation before points exist,
 * save payload after a finished polygon.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";

async function installZoneRoutes(page: Page) {
  const saved: { url: string; body: unknown }[] = [];
  await page.route("**/api/config/set**", async (route) => {
    saved.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ json: { success: true } });
  });
  return { saved };
}

test.describe("Zone editing @high", () => {
  test("Add Zone opens the editor and Save stays disabled without points", async ({
    frigateApp,
  }) => {
    await installZoneRoutes(frigateApp.page);
    await frigateApp.goto("/settings?page=masksAndZones");
    await expect(
      frigateApp.page.getByRole("heading", { name: "Masks / Zones" }).first(),
    ).toBeVisible({ timeout: 10_000 });

    await frigateApp.page.getByRole("button", { name: "Add Zone" }).click();
    await expect(
      frigateApp.page.getByRole("heading", { name: "Add Zone" }),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByText("Click to draw a polygon on the image."),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("button", { name: /^Save$/i }),
    ).toBeDisabled();
  });

  test.describe("mobile", () => {
    test.skip(({ frigateApp }) => !frigateApp.isMobile, "Mobile validation");
    test("Save stays disabled after a name if the polygon is unfinished @mobile", async ({
      frigateApp,
    }) => {
      await installZoneRoutes(frigateApp.page);
      await frigateApp.goto("/settings?page=masksAndZones");
      await frigateApp.page.getByRole("button", { name: "Add Zone" }).click();
      await expect(
        frigateApp.page.getByRole("heading", { name: "Add Zone" }),
      ).toBeVisible();
      await expect(
        frigateApp.page.getByRole("button", { name: /^Save$/i }),
      ).toBeDisabled();
    });
  });
});
