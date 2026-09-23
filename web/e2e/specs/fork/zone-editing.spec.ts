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

  test("Renaming a zone writes the whole rename in one request @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: {
        cameras: {
          front_door: {
            zones: {
              driveway: {
                coordinates: "0.1,0.1,0.5,0.1,0.5,0.5,0.1,0.5",
                enabled: true,
                enabled_in_config: true,
                filters: {},
                inertia: 3,
                loitering_time: 0,
                objects: [],
                distances: [],
                color: [0, 255, 0],
              },
            },
          },
        },
      },
    });
    const { saved } = await installZoneRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    const row = page.locator("[data-index]").filter({ hasText: "driveway" });
    if (frigateApp.isMobile) {
      await row.getByRole("button").last().click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
    } else {
      await row.hover();
      await row.locator("div.absolute > div").first().click();
    }
    await expect(
      page.getByRole("heading", { name: "Edit Zone" }),
    ).toBeVisible();
    // an existing zone opens with its ID field already shown
    await page.getByLabel("ID", { exact: true }).fill("front_drive");
    await page.getByRole("button", { name: /^Save$/i }).click();

    await expect(
      page.getByText("Zone (driveway) has been saved."),
    ).toBeVisible();
    // Deleting the old zone and writing the new one used to be two requests,
    // so a failed second write left the camera without the zone.
    expect(saved).toHaveLength(1);
    const request = saved.at(0);
    expect(request?.url).toMatch(/\/api\/config\/set$/);
    expect(request?.body).toMatchObject({
      update_topic: "config/cameras/front_door/zones",
      config_data: {
        cameras: {
          front_door: {
            zones: {
              driveway: null,
              front_drive: {
                coordinates: expect.stringMatching(/^[\d.,]+$/),
                enabled: true,
                inertia: 3,
                loitering_time: 0,
              },
            },
          },
        },
      },
    });
  });

  // UI91: the name was only sent when it differed from the zone id and a
  // save merges into the zone, so setting it back to the id kept the old one.
  test("Setting a zone's name back to its ID removes the saved name @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: {
        cameras: {
          front_door: {
            zones: {
              driveway: {
                coordinates: "0.1,0.1,0.5,0.1,0.5,0.5,0.1,0.5",
                enabled: true,
                enabled_in_config: true,
                filters: {},
                inertia: 3,
                loitering_time: 0,
                objects: [],
                distances: [],
                color: [0, 255, 0],
                friendly_name: "Front Yard",
              },
            },
          },
        },
      },
    });
    const { saved } = await installZoneRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    const row = page.locator("[data-index]").filter({ hasText: "Front Yard" });
    if (frigateApp.isMobile) {
      await row.getByRole("button").last().click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
    } else {
      await row.hover();
      await row.locator("div.absolute > div").first().click();
    }
    await expect(
      page.getByRole("heading", { name: "Edit Zone" }),
    ).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("driveway");
    await page.getByRole("button", { name: /^Save$/i }).click();

    await expect(
      page.getByText("Zone (driveway) has been saved."),
    ).toBeVisible();
    expect(saved).toHaveLength(1);
    const query = new URL(saved.at(0)?.url ?? "").searchParams;
    expect(query.has("cameras.front_door.zones.driveway.friendly_name")).toBe(
      true,
    );
    expect(query.get("cameras.front_door.zones.driveway.friendly_name")).toBe(
      "",
    );
  });

  test.describe("mobile @mobile-only", () => {
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
