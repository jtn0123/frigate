/**
 * Live grid shapes the upstream specs leave out (UI151): birdseye as a grid
 * tile, a camera without a detect size, and saved layouts the grid has to
 * regenerate instead of convert.
 */

import { test, expect } from "../../fixtures/frigate-test";
import { LivePage } from "../../pages/live.page";
import {
  cameraBoxes,
  persistedLayoutKey,
  readLayout,
  seedLayout,
} from "../../helpers/grid-layout";

const GROUP = "outdoor";

const birdseyeGroup = (restream: boolean) => ({
  config: {
    birdseye: { enabled: true, restream, width: 1920, height: 1080 },
    camera_groups: {
      outdoor: {
        cameras: ["birdseye", "front_door", "backyard"],
        icon: "generic",
        order: 1,
      },
    },
  },
});

test.describe("Live grid shapes @medium @desktop-only", () => {
  for (const restream of [false, true]) {
    test(`birdseye in a group gets its own tile (restream ${restream})`, async ({
      frigateApp,
    }) => {
      await frigateApp.installDefaults(birdseyeGroup(restream));
      await frigateApp.goto(`/?group=${GROUP}`);
      const live = new LivePage(frigateApp.page, true);
      await expect(live.cameraCard("front_door").first()).toBeVisible({
        timeout: 10_000,
      });

      const key = await persistedLayoutKey(frigateApp.page, GROUP);
      await expect
        .poll(async () =>
          (await readLayout(frigateApp.page, key))?.layout.map(
            (item) => item.i,
          ),
        )
        .toEqual(["birdseye", "front_door", "backyard"]);
      await expect(frigateApp.page.locator(".react-grid-item")).toHaveCount(3);
    });
  }

  test("a camera without a detect size gets a standard tile", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      config: { cameras: { backyard: { detect: { width: 0, height: 0 } } } },
    });
    await frigateApp.goto(`/?group=${GROUP}`);
    const live = new LivePage(frigateApp.page, true);
    await expect(live.cameraCard("backyard").first()).toBeVisible({
      timeout: 10_000,
    });

    const { backyard, front_door } = await cameraBoxes(frigateApp.page, [
      "backyard",
      "front_door",
    ] as const);
    expect(backyard.w / backyard.h).toBeCloseTo(front_door.w / front_door.h, 1);
  });

  test("natural aspect regenerates a pre-masonry layout", async ({
    frigateApp,
  }) => {
    await frigateApp.goto(`/?group=${GROUP}`);
    const live = new LivePage(frigateApp.page, true);
    await expect(live.cameraCard("front_door").first()).toBeVisible({
      timeout: 10_000,
    });

    // a bare array only converts in bucketed mode
    const key = await persistedLayoutKey(frigateApp.page, GROUP);
    await seedLayout(frigateApp.page, "naturalAspectLayout:admin", true);
    await seedLayout(frigateApp.page, key, [
      { i: "front_door", x: 4, y: 0, w: 8, h: 8 },
      { i: "backyard", x: 0, y: 0, w: 4, h: 4 },
    ]);
    await frigateApp.page.reload();
    await frigateApp.page.waitForSelector("#pageRoot", { timeout: 10_000 });

    await expect
      .poll(async () => await readLayout(frigateApp.page, key), {
        timeout: 10_000,
      })
      .toMatchObject({ version: 2, naturalAspect: true });
    const stored = await readLayout(frigateApp.page, key);
    expect(stored?.layout.find((item) => item.i === "front_door")?.x).toBe(0);
  });

  test("a malformed pre-masonry layout regenerates", async ({ frigateApp }) => {
    await frigateApp.goto(`/?group=${GROUP}`);
    const live = new LivePage(frigateApp.page, true);
    await expect(live.cameraCard("front_door").first()).toBeVisible({
      timeout: 10_000,
    });

    const key = await persistedLayoutKey(frigateApp.page, GROUP);
    await seedLayout(frigateApp.page, key, [
      { i: "front_door", x: 0, y: 0, w: 4, h: 4 },
      { i: "backyard", x: "4", y: 0, w: 4, h: 4 },
    ]);
    await frigateApp.page.reload();
    await frigateApp.page.waitForSelector("#pageRoot", { timeout: 10_000 });

    await expect(live.cameraCard("backyard").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(async () => (await readLayout(frigateApp.page, key))?.version, {
        timeout: 10_000,
      })
      .toBe(2);
  });
});

test.describe("Live grid shapes on phones @medium @mobile @mobile-only", () => {
  test("birdseye in a group stays in the static grid", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults(birdseyeGroup(false));
    await frigateApp.goto(`/?group=${GROUP}`);
    const live = new LivePage(frigateApp.page, false);
    await expect(live.cameraCard("front_door").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(frigateApp.page.locator(".react-grid-item")).toHaveCount(0);
  });
});
