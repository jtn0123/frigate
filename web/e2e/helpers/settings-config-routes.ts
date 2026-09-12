/**
 * Shared Settings page mocks for schema, config/set, and raw_paths.
 *
 * settings-nav and settings-save both need this trio; keeping it in one
 * helper is what keeps Sonar new-code duplication under the 3% gate.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const CONFIG_SCHEMA = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/mock-data/config-schema.json",
    ),
    "utf-8",
  ),
);

export async function installSettingsConfigRoutes(
  page: Page,
  requireRestart = false,
) {
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
