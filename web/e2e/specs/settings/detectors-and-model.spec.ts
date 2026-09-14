/**
 * Detectors and model settings page tests -- HIGH tier.
 *
 * Tests rendering of the merged page and navigation from the Frigate+ page.
 */

import { test, expect } from "../../fixtures/frigate-test";
import {
  expectNoHorizontalOverflow,
  expectWithinPhoneWidth,
  openPhoneSettingsSection,
} from "../../helpers/settings-phone";

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

test.describe("Detectors and model Settings @high", () => {
  test("page renders with detector and model cards", async ({ frigateApp }) => {
    await frigateApp.goto("/settings?page=systemDetectorsAndModel");
    const pageRoot = frigateApp.page.locator("#pageRoot");

    // The view's own heading; phones also show the section name as the
    // panel title (h2).
    await expect(
      frigateApp.page.getByRole("heading", {
        name: "Detectors and model",
        level: 4,
      }),
    ).toBeVisible();
    await expect(pageRoot).toContainText("Detector Hardware");
    await expect(pageRoot).toContainText("Detection Model");
  });

  test("Frigate+ page links to the merged page", async ({ frigateApp }) => {
    // The link lives on the current-model card, which only renders when
    // Frigate+ is enabled, so enable it with a loaded model.
    await frigateApp.installDefaults({
      config: { plus: { enabled: true }, model: { plus: PLUS_MODEL } },
    });
    await frigateApp.page.route("**/api/plus/models", (route) =>
      route.fulfill({ json: [PLUS_MODEL] }),
    );
    await frigateApp.goto("/settings?page=frigateplus");

    await expect(frigateApp.page.locator("#pageRoot")).toContainText(
      PLUS_MODEL.name,
    );
    await frigateApp.page.getByRole("button", { name: "Change model" }).click();

    // Settings consumes the page param and strips it from the URL, so assert
    // on the rendered view rather than the address bar.
    await expect(
      frigateApp.page.getByRole("heading", {
        name: "Detectors and model",
        level: 4,
      }),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByRole("heading", { name: "Frigate+ Settings" }),
    ).toBeHidden();
    // With Frigate+ enabled the model card offers the Frigate+ tab.
    await expect(
      frigateApp.page.getByRole("tab", { name: "Frigate+" }),
    ).toBeVisible();
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
    "phone opens Detectors and model from the System group @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const { title, back } = await openPhoneSettingsSection(page, {
        group: "System",
        section: "Detectors and model",
      });

      await expect(
        page.getByRole("heading", { name: "Detectors and model", level: 4 }),
      ).toBeVisible();
      const detector = page.getByText("Detector Hardware", { exact: true });
      const model = page.getByText("Detection Model", { exact: true });
      await expectWithinPhoneWidth(detector);
      await expectWithinPhoneWidth(model);
      await expectNoHorizontalOverflow(title);

      // Back slides the panel away and returns to the section list.
      await back.click();
      await expect(title).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Detectors and model", exact: true }),
      ).toBeVisible();
    },
  );
});
