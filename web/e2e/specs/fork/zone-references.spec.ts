/**
 * UI156: zone rename and delete, adapted from upstream #24376
 * (`web/e2e/specs/settings/zones.spec.ts`, 10a0d5ea3).
 *
 * A zone's name also lives in required_zones lists and profile overrides.
 * Renaming or deleting a zone sends one config/set JSON body that moves or
 * drops every reference, the profile overrides' own lists included, and
 * flags a restart. Editing the name alone must not rename the zone. A plain
 * save keeps the fork's query string, so those cases read the query.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { Page } from "@playwright/test";
import { configFactory } from "../../fixtures/mock-data/config";

const SETTINGS_URL = "/settings?page=masksAndZones&camera=front_door";
const COORDINATES = "0.1,0.1,0.5,0.1,0.5,0.5,0.1,0.5";

// /api/config returns zone filters with defaults filled in
const FILTERS = {
  person: {
    min_area: 5000,
    max_area: 24000000,
    min_ratio: 0,
    max_ratio: 24000000,
    threshold: 0.7,
    min_score: 0.5,
    mask: {},
  },
};

type ConfigSetRequest = { url: string; body: Record<string, unknown> };

async function installRoutes(page: Page) {
  const config = configFactory({
    profiles: { armed: { friendly_name: "Armed" } },
    cameras: {
      front_door: {
        zones: {
          driveway: {
            coordinates: COORDINATES,
            enabled: true,
            inertia: 3,
            loitering_time: 0,
            objects: [],
            filters: FILTERS,
            color: [128, 128, 0],
          },
        },
        review: { alerts: { required_zones: ["driveway"] } },
        snapshots: { required_zones: ["driveway"] },
        mqtt: { required_zones: ["driveway"] },
        profiles: {
          armed: {
            zones: { driveway: { coordinates: COORDINATES, inertia: 6 } },
            review: { alerts: { required_zones: ["driveway"] } },
          },
        },
      },
    },
  });

  const requests: ConfigSetRequest[] = [];

  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  await page.route("**/api/config/set**", async (route) => {
    requests.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ json: { success: true } });
  });

  return requests;
}

async function openZoneAction(
  page: Page,
  isMobile: boolean,
  action: "Edit" | "Delete",
) {
  const row = page.locator("[data-index]", { hasText: "Driveway" });

  if (isMobile) {
    await row.locator("button[aria-haspopup='menu']").click();
    await page.getByRole("menuitem", { name: action }).click();
    return;
  }

  // Desktop shows the actions on hover
  await row.hover();
  await row.getByLabel(action, { exact: true }).click();
}

/** The one config/set request a save sent. */
function only(requests: ConfigSetRequest[]): ConfigSetRequest {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) throw new Error("no config/set request");
  return request;
}

/** The decoded query of a plain (non-rename) save. */
function query(request: ConfigSetRequest) {
  return new URL(request.url).searchParams;
}

test.describe("zone rename and delete @medium @mobile", () => {
  test("editing the name of a referenced zone keeps its id", async ({
    frigateApp,
  }) => {
    const requests = await installRoutes(frigateApp.page);
    await frigateApp.goto(SETTINGS_URL);

    await openZoneAction(frigateApp.page, frigateApp.isMobile, "Edit");
    await frigateApp.page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Main Driveway");
    await expect(
      frigateApp.page.getByRole("textbox", { name: "ID", exact: true }),
    ).toHaveValue("driveway");
    await frigateApp.page.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => requests.length).toBe(1);
    const params = query(only(requests));
    expect(params.get("cameras.front_door.zones.driveway.friendly_name")).toBe(
      "Main Driveway",
    );
    expect([...params.keys()].some((key) => key.includes("front_drive"))).toBe(
      false,
    );
    expect(only(requests).body).toMatchObject({ requires_restart: 0 });
  });

  test("turning speed estimation on and off sends no distances delete", async ({
    frigateApp,
  }) => {
    // The zone has no distances in the YAML, and config/set fails to delete
    // a missing key
    const requests = await installRoutes(frigateApp.page);
    await frigateApp.goto(SETTINGS_URL);

    await openZoneAction(frigateApp.page, frigateApp.isMobile, "Edit");
    const speedEstimation = frigateApp.page
      .getByText("Speed Estimation", { exact: true })
      .locator("..")
      .getByRole("switch");
    await speedEstimation.click();
    for (const line of ["A", "B", "C", "D"]) {
      await frigateApp.page
        .getByRole("textbox", { name: new RegExp(`^Line ${line} distance`) })
        .fill("5");
    }
    await speedEstimation.click();
    await frigateApp.page.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => requests.length).toBe(1);
    const keys = [...query(only(requests)).keys()];
    expect(keys).toContain("cameras.front_door.zones.driveway.coordinates");
    expect(keys.filter((key) => /distances|speed_threshold/.test(key))).toEqual(
      [],
    );
  });

  test("renaming a referenced zone moves every reference in one request", async ({
    frigateApp,
  }) => {
    const requests = await installRoutes(frigateApp.page);
    await frigateApp.goto(SETTINGS_URL);

    await openZoneAction(frigateApp.page, frigateApp.isMobile, "Edit");
    await frigateApp.page
      .getByRole("textbox", { name: "ID", exact: true })
      .fill("front_drive");
    await frigateApp.page.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => requests.length).toBe(1);
    const request = only(requests);
    expect(new URL(request.url).search).toBe("");
    expect(request.body).toMatchObject({
      requires_restart: 1,
      update_topic: "config/cameras/front_door/zones",
      config_data: {
        cameras: {
          front_door: {
            zones: {
              driveway: null,
              front_drive: {
                coordinates: COORDINATES,
                enabled: true,
                // the form has no filters field, so they are carried over
                filters: FILTERS,
                inertia: 3,
                loitering_time: 0,
              },
            },
            review: { alerts: { required_zones: ["front_drive"] } },
            snapshots: { required_zones: ["front_drive"] },
            mqtt: { required_zones: ["front_drive"] },
            profiles: {
              armed: {
                review: { alerts: { required_zones: ["front_drive"] } },
                zones: {
                  driveway: null,
                  front_drive: { coordinates: COORDINATES, inertia: 6 },
                },
              },
            },
          },
        },
      },
    });
    await expect(
      frigateApp.page.getByText(
        "Settings saved successfully. Restart Frigate to apply your changes.",
      ),
    ).toBeVisible();
  });

  test("deleting a referenced zone drops every reference in one request", async ({
    frigateApp,
  }) => {
    const requests = await installRoutes(frigateApp.page);
    await frigateApp.goto(SETTINGS_URL);

    await openZoneAction(frigateApp.page, frigateApp.isMobile, "Delete");
    await frigateApp.page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();

    await expect.poll(() => requests.length).toBe(1);
    const request = only(requests);
    expect(new URL(request.url).search).toBe("");
    expect(request.body).toEqual({
      requires_restart: 1,
      update_topic: "config/cameras/front_door/zones",
      config_data: {
        cameras: {
          front_door: {
            zones: { driveway: null },
            review: { alerts: { required_zones: [] } },
            snapshots: { required_zones: [] },
            mqtt: { required_zones: [] },
            profiles: {
              armed: {
                review: { alerts: { required_zones: [] } },
                zones: { driveway: null },
              },
            },
          },
        },
      },
    });
  });
});
