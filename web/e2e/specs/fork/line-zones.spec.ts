/**
 * D75, D76, D77: line zones that count crossings in one or both directions,
 * and exclusion zones that track objects without alerting, in the zone
 * editor. The canvas is Konva, so drawn shapes are read from its stage.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/frigate-test";

const ZONE = {
  enabled: true,
  enabled_in_config: true,
  filters: {},
  inertia: 3,
  loitering_time: 0,
  objects: [],
  distances: [],
};

const ZONES = {
  walkway: {
    ...ZONE,
    coordinates: "0.2,0.6,0.8,0.6",
    type: "line",
    direction: "a_to_b",
    color: [0, 200, 255],
  },
  far_road: {
    ...ZONE,
    coordinates: "0,0,1,0,1,0.3,0,0.3",
    exclusion: true,
    color: [255, 0, 255],
  },
  driveway: {
    ...ZONE,
    coordinates: "0.5,0.5,0.9,0.5,0.9,0.9,0.5,0.9",
    color: [0, 255, 0],
  },
};

async function installRoutes(page: Page) {
  const saved: URL[] = [];
  const counted: URL[] = [];
  await page.route("**/api/config/set**", async (route) => {
    saved.push(new URL(route.request().url()));
    await route.fulfill({ json: { success: true } });
  });
  await page.route("**/api/fork/line_crossings**", async (route) => {
    counted.push(new URL(route.request().url()));
    await route.fulfill({
      json: {
        after: 0,
        before: 1,
        lines: [
          {
            camera: "front_door",
            zone: "walkway",
            direction: "a_to_b",
            total: 12,
            labels: { person: 10, bicycle: 2 },
          },
        ],
      },
    });
  });
  return { saved, counted };
}

type KonvaAttrs = {
  points: number[] | undefined;
  text: string | undefined;
  fillPriority: string | undefined;
  dash: number[] | undefined;
  pointerAtBeginning: boolean | undefined;
  hasPatternImage: boolean;
};

/** Attributes of the canvas shapes with a Konva name. */
async function shapes(page: Page, name: string): Promise<KonvaAttrs[]> {
  return page.evaluate((shapeName) => {
    type Node = { attrs: Record<string, unknown> };
    type Stage = { find: (selector: string) => Node[] };
    const konva = (window as unknown as { Konva?: { stages: Stage[] } }).Konva;
    return (konva?.stages ?? []).flatMap((stage) =>
      stage.find(`.${shapeName}`).map(({ attrs }) => ({
        points: attrs["points"] as number[] | undefined,
        text: attrs["text"] as string | undefined,
        fillPriority: attrs["fillPriority"] as string | undefined,
        dash: attrs["dash"] as number[] | undefined,
        pointerAtBeginning: attrs["pointerAtBeginning"] as boolean | undefined,
        hasPatternImage: attrs["fillPatternImage"] instanceof HTMLCanvasElement,
      })),
    );
  }, name);
}

async function openZoneRow(page: Page, isMobile: boolean, name: string) {
  const row = page.locator("[data-index]").filter({ hasText: name });
  if (isMobile) {
    await row.getByRole("button").last().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
  } else {
    await row.hover();
    await row.locator("div.absolute > div").first().click();
  }
  await expect(page.getByRole("heading", { name: "Edit Zone" })).toBeVisible();
}

test.describe("Line and exclusion zones @high", () => {
  test("a line takes two clicks, shows its sides and saves its direction @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    const { saved } = await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    await page.getByRole("button", { name: "Add Zone" }).click();
    await page.getByTestId("zone-shape-line").click();
    await expect(page.getByTestId("line-zone-hint")).toBeVisible();
    await expect(page.getByTestId("line-zone-alert-hint")).toContainText(
      "Review Classification",
    );
    // a line has no loitering time or speed estimation
    await expect(
      page.getByText("Loitering Time", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByText("Speed Estimation", { exact: true }),
    ).toBeHidden();
    await expect(page.getByText("Click to draw a polygon")).toBeHidden();

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const { width, height } = box ?? { width: 0, height: 0 };
    await canvas.click({ position: { x: width * 0.4, y: height * 0.2 } });
    await canvas.click({ position: { x: width * 0.4, y: height * 0.8 } });
    // a third click adds nothing to a finished line
    await canvas.click({ position: { x: width * 0.7, y: height * 0.5 } });
    await expect(page.getByText("2 points")).toBeVisible();

    await expect
      .poll(async () => (await shapes(page, "line-direction")).length)
      .toBe(1);
    const sides = (await shapes(page, "line-side-A"))
      .concat(await shapes(page, "line-side-B"))
      .map((label) => label.text);
    expect(sides).toEqual(["A", "B"]);
    expect((await shapes(page, "line-direction"))[0]?.pointerAtBeginning).toBe(
      true,
    );

    await page.getByTestId("line-direction-a_to_b").click();
    await expect
      .poll(
        async () =>
          (await shapes(page, "line-direction"))[0]?.pointerAtBeginning,
      )
      .toBe(false);
    // drawn down the frame, side A is on the right: the canvas arrow points
    // left, and so does the button's icon
    await expect(
      page.getByTestId("line-direction-a_to_b").locator("svg"),
    ).toHaveAttribute("style", /rotate\(180deg\)/);

    await page.getByLabel("Name", { exact: true }).fill("Front walk");
    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByText(/has been saved/)).toBeVisible();

    expect(saved).toHaveLength(1);
    const query = saved[0]?.searchParams;
    const prefix = "cameras.front_door.zones.front_walk";
    expect(query?.get(`${prefix}.type`)).toBe("line");
    expect(query?.get(`${prefix}.direction`)).toBe("a_to_b");
    expect(query?.get(`${prefix}.loitering_time`)).toBe("0");
    expect(query?.get(`${prefix}.coordinates`)?.split(",")).toHaveLength(4);
    expect(query?.has(`${prefix}.exclusion`)).toBe(false);
  });

  test("the zone list marks lines and exclusion zones and counts today's crossings @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      // UTC+14 all year, so its midnight is not the browser's
      config: {
        ui: { timezone: "Pacific/Kiritimati" },
        cameras: { front_door: { zones: ZONES } },
      },
    });
    const { counted } = await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    const walkway = page.locator("[data-index]").filter({ hasText: "walkway" });
    await expect(walkway).toContainText("Line, A to B");
    await expect(page.getByTestId("line-crossings-walkway")).toHaveText(
      "12 crossings today",
    );
    await expect(page.getByTestId("exclusion-badge-far_road")).toHaveText(
      "Exclusion",
    );
    await expect(page.getByTestId("exclusion-badge-driveway")).toHaveCount(0);

    const request = counted[0];
    expect(request?.searchParams.get("camera")).toBe("front_door");
    // "today" starts at midnight in the UI's time zone
    const after = Number(request?.searchParams.get("after"));
    const day = 24 * 3600;
    const offset = 14 * 3600;
    const now = Math.floor(Date.now() / 1000);
    expect(after).toBe(Math.floor((now + offset) / day) * day - offset);

    // the line is drawn with its arrow, the exclusion zone hatched
    await expect
      .poll(async () => (await shapes(page, "line-direction")).length)
      .toBe(1);
    const fills = (await shapes(page, "filled-line")).map(
      (shape) => shape.fillPriority ?? "color",
    );
    expect(fills.sort()).toEqual(["color", "pattern"]);
    const hatched = (await shapes(page, "filled-line")).filter(
      (shape) => shape.fillPriority === "pattern",
    );
    expect(hatched.map((shape) => shape.hasPatternImage)).toEqual([true]);
  });

  test("flipping a saved line's direction keeps it a line @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: { cameras: { front_door: { zones: ZONES } } },
    });
    const { saved } = await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    await openZoneRow(page, frigateApp.isMobile, "walkway");
    await expect(page.getByTestId("line-direction-a_to_b")).toHaveAttribute(
      "data-state",
      "on",
    );
    await page.getByTestId("line-direction-b_to_a").click();
    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByText(/has been saved/)).toBeVisible();

    const query = saved[0]?.searchParams;
    expect(query?.get("cameras.front_door.zones.walkway.type")).toBe("line");
    expect(query?.get("cameras.front_door.zones.walkway.direction")).toBe(
      "b_to_a",
    );
    expect(query?.get("cameras.front_door.zones.walkway.coordinates")).toBe(
      "0.2,0.6,0.8,0.6",
    );
  });

  test("marking a zone as an exclusion zone hatches and saves it @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: { cameras: { front_door: { zones: ZONES } } },
    });
    const { saved } = await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    await openZoneRow(page, frigateApp.isMobile, "driveway");
    await expect(
      page.getByText("Exclusion zone", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Unlike an object mask/)).toBeVisible();
    await page.getByTestId("zone-exclusion").click();
    await expect
      .poll(async () =>
        (await shapes(page, "filled-line"))
          .filter((shape) => shape.fillPriority === "pattern")
          .map((shape) => shape.hasPatternImage),
      )
      .toEqual([true, true]);

    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByText(/has been saved/)).toBeVisible();
    const query = saved[0]?.searchParams;
    expect(query?.get("cameras.front_door.zones.driveway.exclusion")).toBe(
      "True",
    );
    expect(query?.has("cameras.front_door.zones.driveway.type")).toBe(false);
  });

  test("the shape controls show keyboard focus, and the exclusion switch sits by its label @desktop-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await frigateApp.installDefaults({
      config: { cameras: { front_door: { zones: ZONES } } },
    });
    await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    // arrow keys move focus along the direction picker
    await openZoneRow(page, false, "walkway");
    await page.getByTestId("line-direction-a_to_b").focus();
    await page.keyboard.press("ArrowRight");
    const b2a = page.getByTestId("line-direction-b_to_a");
    await expect(b2a).toBeFocused();
    await expect(b2a).not.toHaveCSS("box-shadow", "none");
    await page.getByRole("button", { name: "Cancel" }).click();

    // Tab leaves the shape toggle for the exclusion switch
    await openZoneRow(page, false, "driveway");
    await page.getByTestId("zone-shape-polygon").focus();
    await page.keyboard.press("Tab");
    const exclusion = page.getByTestId("zone-exclusion");
    await expect(exclusion).toBeFocused();
    await expect(exclusion).not.toHaveCSS("box-shadow", "none");

    const label = await page
      .getByText("Exclusion zone", { exact: true })
      .boundingBox();
    const toggle = await exclusion.boundingBox();
    const middle = (box: { y: number; height: number } | null) =>
      (box?.y ?? 0) + (box?.height ?? 0) / 2;
    expect(Math.abs(middle(toggle) - middle(label))).toBeLessThan(8);
  });

  test("the object mask editor explains masks against exclusion zones", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    await page.getByRole("button", { name: "Add Object Mask" }).click();
    await expect(page.getByTestId("mask-vs-exclusion")).toContainText(
      "use an exclusion zone instead",
    );
  });

  test("with the flag off the editor has no shape controls", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.addInitScript(() =>
      localStorage.setItem("frigateFork", JSON.stringify({ lineZones: false })),
    );
    const { saved } = await installRoutes(page);
    await frigateApp.goto("/settings?page=masksAndZones&camera=front_door");

    await page.getByRole("button", { name: "Add Zone" }).click();
    await expect(page.getByText("Click to draw a polygon")).toBeVisible();
    await expect(page.getByTestId("zone-shape-fields")).toHaveCount(0);
    expect(saved).toHaveLength(0);
  });
});
