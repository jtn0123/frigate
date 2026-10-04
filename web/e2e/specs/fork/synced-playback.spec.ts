/**
 * Fork (UI143): synced multi-camera playback in the recording view.
 *
 * The grid is off until the header toggle turns it on. It opens with the
 * main camera plus the cameras that had activity near the playhead, shows
 * a "No recording" card on a camera without footage at the master time,
 * and lets the user add, remove and promote cameras. A click promotes a
 * tile in place and a double-click fullscreens it. Two cameras sit side by
 * side on a desktop; phones get two tiles, stacked in portrait. At the end
 * of the saved footage the tiles say they caught up with live.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../fixtures/frigate-test";

/**
 * Ten minutes ago, unless the activity and backyard's gap around it, from
 * two minutes before to three after, would straddle an hour. The grid plays
 * one hour chunk at a time, so backyard's next recording would then fall in
 * the next chunk; the test plays five minutes before that hour instead.
 */
const START = (() => {
  const start = Math.floor(Date.now() / 1000) - 600;
  const hour = new Date((start + 180) * 1000);
  hour.setMinutes(0, 0, 0);
  const boundary = hour.getTime() / 1000;

  return boundary > start - 120 ? boundary - 300 : start;
})();

function review(id: string, camera: string, offset: number) {
  return {
    id,
    camera,
    start_time: START + offset,
    end_time: START + offset + 20,
    has_been_reviewed: false,
    severity: "alert",
    thumb_path: `/clips/${camera}/${id}-thumb.jpg`,
    data: {
      audio: [],
      detections: [],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

/** Every camera records the whole window except backyard around START. */
async function mockCoverage(page: Page) {
  await page.route("**/api/*/recordings/coverage**", (route) => {
    const url = new URL(route.request().url());
    const camera = url.pathname.split("/").at(-3);
    const after = Number(url.searchParams.get("after"));
    const before = Number(url.searchParams.get("before"));
    const spans =
      camera == "backyard"
        ? [
            { start_time: after, end_time: START - 60 },
            { start_time: START + 120, end_time: before },
          ]
        : [{ start_time: after, end_time: before }];

    return route.fulfill({
      json: {
        spans: spans.map((span) => ({ ...span, streams: ["main"] })),
        codecs_compatible: true,
        streams: { main: { video_codec: "h264", has_audio: false } },
      },
    });
  });
}

async function openGrid(page: Page) {
  const toggle = page.getByTestId("synced-playback-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const grid = page.getByTestId("synced-playback");
  await expect(grid).toBeVisible();
  return grid;
}

function tiles(grid: Locator) {
  return grid.locator('[data-testid^="synced-tile-"]');
}

function tileOrder(grid: Locator) {
  return tiles(grid).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

function fullscreenTile(page: Page) {
  return page.evaluate(
    () => document.fullscreenElement?.getAttribute("data-testid") ?? null,
  );
}

test.describe("Synced multi-camera playback @high", () => {
  test.beforeEach(async ({ frigateApp }) => {
    await frigateApp.installDefaults({
      reviews: [
        review("synced-front", "front_door", 0),
        review("synced-garage", "garage", -90),
        review("synced-backyard", "backyard", 30),
      ],
    });
    await mockCoverage(frigateApp.page);
    await frigateApp.goto(`/review?timestamp=front_door_${START}`);
  });

  test(
    "shows the active cameras in sync with a gap card, picker and promote",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const grid = await openGrid(page);

      // main camera first, then activity nearest the playhead
      await expect(tiles(grid)).toHaveCount(3);
      await expect(tiles(grid).nth(0)).toHaveAttribute(
        "data-testid",
        "synced-tile-front_door",
      );
      await expect(tiles(grid).nth(1)).toHaveAttribute(
        "data-testid",
        "synced-tile-backyard",
      );
      const front = grid.getByTestId("synced-tile-front_door");
      await expect(front).toHaveAttribute("data-main", "true");
      await expect(front.getByText("Main", { exact: true })).toBeVisible();

      // backyard has no footage at the playhead
      const backyard = grid.getByTestId("synced-tile-backyard");
      await expect(backyard).toHaveAttribute("data-gap", "true");
      await expect(backyard.getByTestId("synced-gap")).toContainText(
        "No recording",
      );
      await expect(backyard.getByTestId("synced-gap")).toContainText(
        "Next recording at",
      );
      await expect(
        grid.getByTestId("synced-tile-garage").getByTestId("synced-gap"),
      ).toHaveCount(0);

      // one control bar drives every tile
      await expect(grid.getByTestId("synced-playback-clock")).not.toBeEmpty();
      await grid.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(
        grid.getByRole("button", { name: "Play", exact: true }),
      ).toBeVisible();
      await expect(grid.getByTestId("synced-playback-status")).toContainText(
        "In sync",
      );
      await grid.getByRole("button", { name: "1x", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "2x" }).click();
      await expect(
        grid.getByRole("button", { name: "2x", exact: true }),
      ).toBeVisible();

      // the picker removes and adds cameras; the main one stays
      await grid.getByRole("button", { name: "Choose cameras" }).click();
      const menu = page.getByRole("menu");
      await expect(
        menu.getByRole("menuitemcheckbox", { name: /front door/i }),
      ).toBeDisabled();
      const garageItem = menu.getByRole("menuitemcheckbox", {
        name: /garage/i,
      });
      await expect(garageItem).toBeChecked();
      await garageItem.click();
      await expect(tiles(grid)).toHaveCount(2);
      await expect(garageItem).not.toBeChecked();
      await garageItem.click();
      await expect(tiles(grid)).toHaveCount(3);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      // clicking a tile makes it the main camera
      await grid
        .getByRole("button", { name: "Make Backyard the main camera" })
        .click();
      await expect(backyard).toHaveAttribute("data-main", "true");
      await expect(front).toHaveAttribute("data-main", "false");

      // the old main camera can now be removed
      await grid
        .getByRole("button", { name: "Remove Front Door from the grid" })
        .click();
      await expect(tiles(grid)).toHaveCount(2);
      await expect(grid.getByTestId("synced-tile-front_door")).toHaveCount(0);

      // the choice survives a reload, and the toggle turns it off
      await page.reload();
      const toggle = page.getByTestId("synced-playback-toggle");
      await expect(page.getByTestId("synced-playback")).toBeVisible({
        timeout: 15_000,
      });
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await toggle.click();
      await expect(page.getByTestId("synced-playback")).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    },
  );

  test(
    "promotes a clicked tile without moving any tile",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const grid = await openGrid(page);
      await expect(tiles(grid)).toHaveCount(3);
      const order = await tileOrder(grid);
      const garage = grid.getByTestId("synced-tile-garage");
      const before = await garage.boundingBox();

      const point = await center(garage);
      await page.mouse.click(point.x, point.y);
      await expect(garage).toHaveAttribute("data-main", "true");
      await expect(grid.getByTestId("synced-tile-front_door")).toHaveAttribute(
        "data-main",
        "false",
      );

      // the default order puts the main camera first; a promote keeps it
      expect(await tileOrder(grid)).toEqual(order);
      expect(await garage.boundingBox()).toEqual(before);
    },
  );

  test(
    "fullscreens the tile that was double-clicked",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const grid = await openGrid(page);
      await expect(tiles(grid)).toHaveCount(3);
      const garage = grid.getByTestId("synced-tile-garage");
      await expect(garage).toHaveAttribute("data-main", "false");

      // the first click promotes garage; the second must land on it too
      const point = await center(garage);
      await page.mouse.dblclick(point.x, point.y);
      await expect.poll(() => fullscreenTile(page)).toBe("synced-tile-garage");
      await expect(garage).toHaveAttribute("data-main", "true");

      await page.evaluate(() => document.exitFullscreen());
      await expect.poll(() => fullscreenTile(page)).toBeNull();
    },
  );

  test(
    "puts two cameras side by side on a 1440x900 screen",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await page.setViewportSize({ width: 1440, height: 900 });
      const grid = await openGrid(page);
      await expect(tiles(grid)).toHaveCount(3);
      await grid
        .getByRole("button", { name: "Remove Garage from the grid" })
        .click();
      await expect(tiles(grid)).toHaveCount(2);

      // stacked, each tile left about 294 px empty on either side
      await expect
        .poll(async () => {
          const [first, second] = await Promise.all([
            tiles(grid).nth(0).boundingBox(),
            tiles(grid).nth(1).boundingBox(),
          ]);
          return (
            !!first &&
            !!second &&
            second.x >= first.x + first.width &&
            Math.abs(second.y - first.y) < 1
          );
        })
        .toBe(true);
    },
  );

  test(
    "stacks two tiles on a phone in portrait @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      const grid = await openGrid(page);

      await expect(tiles(grid)).toHaveCount(2);
      const first = await tiles(grid).nth(0).boundingBox();
      const second = await tiles(grid).nth(1).boundingBox();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.y).toBeGreaterThan(first!.y + first!.height / 2);

      // a fingertip needs 44 px; the tile buttons sit on the promote target
      const buttons = await grid
        .locator('[data-testid^="synced-tile-"] button[title]')
        .all();
      expect(buttons.length).toBe(3);
      for (const button of buttons) {
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      await grid.getByRole("button", { name: "Choose cameras" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toContainText("Up to 2 cameras play at once.");
      await expect(
        menu.getByRole("menuitemcheckbox", { name: /garage/i }),
      ).toBeDisabled();
    },
  );
});

test.describe("Synced playback at the live edge @high", () => {
  test(
    "says the tiles caught up with live and offers the live view",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;

      // the newest 30 s of every camera is not saved yet
      await page.route("**/api/*/recordings/coverage**", (route) => {
        const url = new URL(route.request().url());
        const after = Number(url.searchParams.get("after"));
        const before = Number(url.searchParams.get("before"));
        const spans =
          before - 30 > after
            ? [{ start_time: after, end_time: before - 30 }]
            : [];

        return route.fulfill({
          json: {
            spans: spans.map((span) => ({ ...span, streams: ["main"] })),
            codecs_compatible: true,
            streams: { main: { video_codec: "h264", has_audio: false } },
          },
        });
      });

      // a few seconds before now, inside the current hour
      const now = Math.floor(Date.now() / 1000);
      const hour = new Date(now * 1000);
      hour.setMinutes(0, 0, 0);
      const at = Math.max(now - 10, hour.getTime() / 1000 + 1);
      await frigateApp.goto(`/review?timestamp=front_door_${at}`);

      const grid = await openGrid(page);
      await expect(tiles(grid)).toHaveCount(2);
      const front = grid.getByTestId("synced-tile-front_door");
      const card = front.getByTestId("synced-gap");
      await expect(card).toHaveAttribute("data-live-edge", "true");
      await expect(card).toContainText("Caught up to live");
      await expect(card).not.toContainText("No more recordings");
      await expect(
        grid.getByRole("button", { name: "Play", exact: true }),
      ).toBeVisible();

      await card.getByRole("button", { name: "Go to Live" }).click();
      await expect(page).toHaveURL(/\/#front_door$/);
    },
  );
});
