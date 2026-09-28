/**
 * Detection models settings page tests -- HIGH tier.
 *
 * Tests rendering of the merged page and navigation from the Frigate+ page.
 */

import { readFileSync } from "node:fs";
import { test, expect } from "../../fixtures/frigate-test";
import {
  expectNoHorizontalOverflow,
  expectWithinPhoneWidth,
  openPhoneSettingsSection,
} from "../../helpers/settings-phone";

const CONFIG_SCHEMA = JSON.parse(
  readFileSync(
    new URL("../../fixtures/mock-data/config-schema.json", import.meta.url),
    "utf-8",
  ),
);

const PLUS_MODEL = {
  id: "plus-model-1",
  type: "yolonas",
  name: "Frigate+ test model",
  isBaseModel: false,
  supportedDetectors: ["cpu"],
  trainDate: "2026-01-15T00:00:00Z",
  baseModel: "yolonas-2026.1",
  width: 320,
  height: 320,
};

test.describe("Detection models Settings @high", () => {
  test.beforeEach(async ({ frigateApp }) => {
    await frigateApp.installDefaults({ configSchema: CONFIG_SCHEMA });
  });
  test("page renders the model editor", async ({ frigateApp }) => {
    await frigateApp.goto("/settings?page=systemDetectorsAndModel");
    const pageRoot = frigateApp.page.locator("#pageRoot");

    await expect(pageRoot).toContainText("All cameras");
    await expect(
      pageRoot.getByRole("button", { name: "Add model" }),
    ).toBeVisible();
  });

  test("Frigate+ page links to the merged page", async ({ frigateApp }) => {
    // The link lives on the current-model card, which only renders when
    // Frigate+ is enabled, so enable it with a loaded model.
    await frigateApp.installDefaults({
      configSchema: CONFIG_SCHEMA,
      config: {
        plus: { enabled: true },
        models: [{ scene: "all", devices: ["cpu"], plus: PLUS_MODEL }],
      },
    });
    await frigateApp.page.route("**/api/plus/models", (route) =>
      route.fulfill({ json: [PLUS_MODEL] }),
    );
    await frigateApp.goto("/settings?page=frigateplus");

    await expect(frigateApp.page.locator("#pageRoot")).toContainText(
      PLUS_MODEL.name,
    );
    await frigateApp.page.getByRole("button", { name: "Change model" }).click();

    await expect(frigateApp.page.locator("#pageRoot")).toContainText(
      "All cameras",
    );
    await expect(
      frigateApp.page.getByRole("heading", { name: "Frigate+ Settings" }),
    ).toBeHidden();
  });

  test("old systemDetectionModel deep-link no longer routes here", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/settings?page=systemDetectionModel");
    const pageRoot = frigateApp.page.locator("#pageRoot");
    // The old page key is no longer in allSettingsViews, so the router falls
    // back to the settings shell (the UI settings entry is always listed).
    await expect(pageRoot).toContainText("UI settings");
    await expect(pageRoot).not.toContainText("Detector Hardware");
    await expect(pageRoot).not.toContainText("Detection Model");
  });

  test(
    "phone opens Detection models from the System group @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const { title, back } = await openPhoneSettingsSection(page, {
        group: "System",
        section: "Detection models",
      });

      const model = page.getByText("All cameras", { exact: true }).first();
      await expectWithinPhoneWidth(model);
      await expectWithinPhoneWidth(
        page.getByRole("button", { name: "Add model" }),
      );
      await expectNoHorizontalOverflow(title);

      // Back slides the panel away and returns to the section list.
      await back.click();
      await expect(title).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Detection models", exact: true }),
      ).toBeVisible();
    },
  );
});
