/**
 * LPR known plates picker -- MEDIUM tier.
 *
 * Each known-plate entry is a combobox that lists plates Frigate has already
 * recognized and still accepts free text, so a regex remains typeable.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../../fixtures/frigate-test";
import type { Page } from "@playwright/test";
import { configFactory } from "../../fixtures/mock-data/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_SCHEMA = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../fixtures/mock-data/config-schema.json"),
    "utf-8",
  ),
);

const SETTINGS_URL = "/settings?page=integrationLpr";
const RECOGNIZED = ["ABC123", "XYZ789"];

async function installRoutes(page: Page) {
  const config = configFactory({
    lpr: { enabled: true, known_plates: { Wife: ["ABC123"] } },
  });

  await page.route("**/api/config/schema.json", (route) =>
    route.fulfill({ json: CONFIG_SCHEMA }),
  );
  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  await page.route("**/api/config/raw_paths", (route) =>
    route.fulfill({
      json: { lpr: { enabled: true, known_plates: { Wife: ["ABC123"] } } },
    }),
  );
  await page.route("**/api/recognized_license_plates**", (route) =>
    route.fulfill({ json: RECOGNIZED }),
  );
}

test.describe("LPR known plates picker @medium @mobile", () => {
  test("picks a recognized plate and accepts a custom regex", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    await installRoutes(page);
    await frigateApp.goto(SETTINGS_URL);

    // known plates sits in the section's advanced fields
    await page.getByRole("button", { name: /Advanced Settings/ }).click();

    const plate = page.getByRole("combobox").filter({ hasText: "ABC123" });
    await expect(plate).toBeVisible();
    await plate.click();

    // the search opens seeded with the current plate, selected, so typing
    // replaces it
    const picker = page.getByRole("dialog");
    await expect(picker.getByText("Detected plates")).toBeVisible();
    await expect(picker.getByRole("option", { name: "ABC123" })).toBeVisible();
    await expect(picker.getByRole("combobox")).toBeFocused();
    await page.keyboard.type("XYZ789");
    await expect(picker.getByRole("combobox")).toHaveValue("XYZ789");
    // an exact match hides the free-text row, so Enter takes the detected plate
    await expect(picker.getByRole("option")).toHaveCount(1);
    await expect(picker.getByRole("option", { name: "XYZ789" })).toBeVisible();
    await page.keyboard.press("Enter");

    const picked = page.getByRole("combobox").filter({ hasText: "XYZ789" });
    await expect(picked).toBeVisible();

    await picked.click();
    await expect(picker.getByRole("combobox")).toBeFocused();
    await page.keyboard.type("^AB.*");
    await expect(picker.getByRole("combobox")).toHaveValue("^AB.*");
    await expect(
      page.getByRole("option", { name: 'Use "^AB.*"' }),
    ).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("combobox").filter({ hasText: "^AB.*" }),
    ).toBeVisible();
  });
});
