/**
 * Live page tests -- CRITICAL tier.
 *
 * Dashboard grid, single-camera controls, feature toggles (with WS
 * frame assertions), context menu, birdseye, and mobile layout.
 * Also absorbs the PTZ preset-dropdown regression tests from the
 * now-deleted ptz-overlay.spec.ts.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/frigate-test";
import { LivePage } from "../pages/live.page";
import { BASE_STATS } from "../fixtures/mock-data/stats";
import { installWsFrameCapture, waitForWsFrame } from "../helpers/ws-frames";
import { openStatusIssues } from "../helpers/status-issues";
import {
  expectBodyInteractive,
  waitForBodyInteractive,
} from "../helpers/overlay-interaction";

const PTZ_CAMERA = "front_door";
const PRESET_NAMES = ["home", "driveway", "front_porch"];

test.describe("Live Dashboard @critical", () => {
  test("every configured camera renders on the dashboard", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    const live = new LivePage(frigateApp.page, !frigateApp.isMobile);
    for (const cam of ["front_door", "backyard", "garage"]) {
      await expect(live.cameraCard(cam)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("clicking a camera card opens the single-camera view via hash", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    const live = new LivePage(frigateApp.page, !frigateApp.isMobile);
    await live.cameraCard("front_door").first().click({ timeout: 10_000 });
    await expect(frigateApp.page).toHaveURL(/#front_door/);
  });

  test("birdseye route renders without crash", async ({ frigateApp }) => {
    await frigateApp.goto("/#birdseye");
    await expect(frigateApp.page.locator("body")).toBeVisible();
    await expect(frigateApp.page.locator("#pageRoot")).toBeVisible();
  });

  test("empty group shows fallback content", async ({ frigateApp }) => {
    await frigateApp.page.goto("/?group=nonexistent");
    await frigateApp.page.waitForSelector("#pageRoot", { timeout: 10_000 });
    await expect(frigateApp.page.locator("#pageRoot")).toBeVisible();
  });
});

test.describe("Live Single Camera — desktop controls @critical", () => {
  test.skip(
    ({ frigateApp }) => frigateApp.isMobile,
    "Desktop-only header controls",
  );

  test("single-camera view shows Back and History buttons", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/#front_door");
    const live = new LivePage(frigateApp.page, true);
    await expect(live.backButton).toBeVisible({ timeout: 5_000 });
    await expect(live.historyButton).toBeVisible();
  });

  test("feature toggles render (at least 3)", async ({ frigateApp }) => {
    await frigateApp.goto("/#front_door");
    const live = new LivePage(frigateApp.page, true);
    // Wait for the single-camera header to render before counting toggles.
    await expect(live.backButton).toBeVisible({ timeout: 5_000 });
    await expect(live.featureToggles.first()).toBeVisible({ timeout: 5_000 });
    const count = await live.featureToggles.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("clicking a feature toggle sends the matching WS frame", async ({
    frigateApp,
  }) => {
    await installWsFrameCapture(frigateApp.page);
    await frigateApp.goto("/#front_door");
    const live = new LivePage(frigateApp.page, true);
    // Wait for feature toggles to render (WS camera_activity must arrive first).
    await expect(live.activeFeatureToggles.first()).toBeVisible({
      timeout: 5_000,
    });
    const activeBefore = await live.activeFeatureToggles.count();
    expect(activeBefore).toBeGreaterThan(0);

    await live.activeFeatureToggles.first().click();

    // The toggle dispatches a frame on <camera>/<feature>/set — match on
    // front_door/ prefix + /set suffix (any feature).
    await waitForWsFrame(
      frigateApp.page,
      (frame) => frame.includes("front_door/") && frame.includes("/set"),
      {
        message:
          "feature toggle should dispatch a <camera>/<feature>/set frame",
      },
    );
  });

  test("keyboard shortcut f does not crash", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    await frigateApp.page.keyboard.press("f");
    await expect(frigateApp.page.locator("body")).toBeVisible();
    // Note: headless Chromium rejects fullscreen requests without a user
    // gesture, so document.fullscreenElement cannot be asserted reliably
    // in e2e. We assert the keypress doesn't crash the app; real
    // fullscreen behavior is covered by manual testing.
  });

  test("settings gear opens a dropdown with Stream/Play menu items", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/#front_door");
    // Wait for the single-camera view to render — use the Back button
    // as a deterministic marker.
    const live = new LivePage(frigateApp.page, true);
    await expect(live.backButton).toBeVisible({ timeout: 10_000 });

    // The gear icon button is the last button-like element in the
    // single-camera header. Clicking it opens a Radix dropdown.
    const gearButtons = frigateApp.page.locator("button:has(svg)");
    const count = await gearButtons.count();
    expect(count).toBeGreaterThan(0);
    await gearButtons.last().click();

    const menu = frigateApp.page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await frigateApp.page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe("Live Context Menu (desktop) @critical", () => {
  test.skip(
    ({ frigateApp }) => frigateApp.isMobile,
    "Right-click is desktop-only",
  );

  test("right-click opens the context menu", async ({ frigateApp }) => {
    await frigateApp.goto("/");
    const live = new LivePage(frigateApp.page, true);
    const menu = await live.openContextMenuOn("front_door");
    await expect(menu).toBeVisible({ timeout: 5_000 });
  });

  test("context menu closes on Escape and leaves body interactive", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    const live = new LivePage(frigateApp.page, true);
    const menu = await live.openContextMenuOn("front_door");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await frigateApp.page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await waitForBodyInteractive(frigateApp.page);
    await expectBodyInteractive(frigateApp.page);
  });
});

test.describe("Live PTZ preset dropdown @critical", () => {
  // Migrated from ptz-overlay.spec.ts. Guards:
  //  1. After selecting a preset, the "Presets" tooltip must not re-pop.
  //  2. Keyboard shortcuts after close should not re-open the dropdown.

  test("selecting a preset closes menu cleanly and does not re-open on keyboard", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile, "PTZ preset dropdown is desktop-only");

    await frigateApp.api.install({
      config: {
        cameras: {
          [PTZ_CAMERA]: { onvif: { host: "10.0.0.50" } },
        },
      },
    });
    await frigateApp.page.route(`**/api/${PTZ_CAMERA}/ptz/info`, (route) =>
      route.fulfill({
        json: {
          name: PTZ_CAMERA,
          features: ["pt", "zoom"],
          presets: PRESET_NAMES,
          profiles: [],
        },
      }),
    );

    await installWsFrameCapture(frigateApp.page);
    await frigateApp.goto(`/#${PTZ_CAMERA}`);

    const presetTrigger = frigateApp.page.getByRole("button", {
      name: /presets/i,
    });
    await expect(presetTrigger.first()).toBeVisible({ timeout: 5_000 });
    await presetTrigger.first().click();

    const menu = frigateApp.page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 3_000 });

    await menu.getByRole("menuitem", { name: PRESET_NAMES[0] }).first().click();
    await expect(menu).not.toBeVisible({ timeout: 3_000 });

    await waitForWsFrame(
      frigateApp.page,
      (frame) =>
        frame.includes(`"${PTZ_CAMERA}/ptz"`) &&
        frame.includes(`preset_${PRESET_NAMES[0]}`),
    );

    await waitForBodyInteractive(frigateApp.page);
    await expectBodyInteractive(frigateApp.page);

    await expect
      .poll(
        async () =>
          frigateApp.page
            .locator('[role="tooltip"]')
            .filter({ hasText: /presets/i })
            .isVisible()
            .catch(() => false),
        { timeout: 1_000 },
      )
      .toBe(false);

    await frigateApp.page.keyboard.press("ArrowUp");
    await frigateApp.page.keyboard.press("Space");
    await frigateApp.page.keyboard.press("Enter");
    await expect
      .poll(() => menu.isVisible().catch(() => false), { timeout: 1_000 })
      .toBe(false);
  });
});

test.describe("Live mobile layout @critical @mobile", () => {
  test("mobile dashboard has no sidebar and renders cameras", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile-only");
    await frigateApp.goto("/");
    await expect(frigateApp.page.locator("aside")).toHaveCount(0);
    const live = new LivePage(frigateApp.page, false);
    await expect(live.cameraCard("front_door")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("mobile camera tap opens single view", async ({ frigateApp }) => {
    test.skip(!frigateApp.isMobile, "Mobile-only");
    await frigateApp.goto("/");
    const live = new LivePage(frigateApp.page, false);
    await live.cameraCard("front_door").first().click({ timeout: 10_000 });
    await expect(frigateApp.page).toHaveURL(/#front_door/);
  });

  test("mobile onvif single-camera view loads without freezing body", async ({
    frigateApp,
  }) => {
    test.skip(!frigateApp.isMobile, "Mobile-only");
    // Migrated from ptz-overlay.spec.ts — dismissable-layer dedupe smoke test.
    await frigateApp.api.install({
      config: {
        cameras: { [PTZ_CAMERA]: { onvif: { host: "10.0.0.50" } } },
      },
    });
    await frigateApp.page.route(`**/api/${PTZ_CAMERA}/ptz/info`, (route) =>
      route.fulfill({
        json: {
          name: PTZ_CAMERA,
          features: ["pt", "zoom"],
          presets: PRESET_NAMES,
          profiles: [],
        },
      }),
    );
    await frigateApp.goto(`/#${PTZ_CAMERA}`);
    await expectBodyInteractive(frigateApp.page);
    await expect(frigateApp.page.locator("body")).toBeVisible();
  });
});

test.describe("Live camera groups @critical @mobile", () => {
  // UI46: groups using the backend's default icon ("generic") rendered as
  // blank buttons, and every group button was named "Camera Groups".
  test("group buttons show an icon and are named after the group", async ({
    frigateApp,
  }) => {
    await frigateApp.goto("/");
    // "default" uses the backend's default icon and is shown on both layouts
    // (phones collapse the rest behind "Show all camera groups")
    const group = frigateApp.page.getByRole("button", {
      name: "default",
      exact: true,
    });
    await expect(group).toBeVisible({ timeout: 10_000 });
    await expect(group.locator("svg")).toHaveCount(1);
    // exact: "Edit Camera Groups" is a different, correctly named button
    await expect(
      frigateApp.page.getByRole("button", {
        name: "Camera Groups",
        exact: true,
      }),
    ).toHaveCount(0);
  });
});

test.describe("Status bar wording @critical", () => {
  // UI52: the slow-detector warning capitalized only the first letter of
  // the detector key, so the default `cpu` detector read "Cpu is slow".
  test(
    "a slow cpu detector reads CPU in the status bar",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      await frigateApp.goto("/");
      // The status bar reads live stats from the websocket, whose connect
      // frame carries no detectors; push the fixture stats (detector "cpu"
      // at 75.5 ms inference) so the slow-detector warning is raised.
      // A push that lands before the connect frame is overwritten by it, so
      // resend until the warning shows.
      await expect(async () => {
        frigateApp.ws.send(
          "stats",
          JSON.stringify({
            ...BASE_STATS,
            service: {
              ...BASE_STATS.service,
              last_updated: Date.now() / 1000,
            },
          }),
        );
        // UI110: the bar lists its warnings behind a chip
        const list = await openStatusIssues(frigateApp.page);
        // exact: the default text match ignores case, and "Cpu" would pass
        await expect(
          list.getByText("CPU is slow (75.5 ms)", { exact: true }),
        ).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      // checked once, while the warning is showing: a retrying toHaveCount
      // would pass as soon as later stats clear the warning
      expect(await frigateApp.page.getByText(/Cpu is slow/).count()).toBe(0);
    },
  );
});

test.describe("Manual recording confirmation @critical @desktop-only", () => {
  test.use({
    expectedErrors: [/500.*\/api\/events\/manual-regression\/end/],
  });

  test("failed stop keeps the event available for retry", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let stops = 0;
    await page.route("**/api/events/front_door/on_demand/create", (route) =>
      route.fulfill({ json: { success: true, event_id: "manual-regression" } }),
    );
    await page.route("**/api/events/manual-regression/end", (route) => {
      stops++;
      return route.fulfill({
        status: stops === 1 ? 500 : 200,
        json: { success: stops !== 1 },
      });
    });
    await frigateApp.goto("/#front_door");
    await page
      .getByRole("button", { name: "Start on-demand recording", exact: true })
      .click();
    const stop = page.getByRole("button", {
      name: /^(Stop|End on-demand recording)$/,
    });
    await stop.click();
    await expect(
      page
        .locator("#pageRoot")
        .getByText("Failed to end manual on-demand recording.", {
          exact: true,
        }),
    ).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(
      page
        .locator("#pageRoot")
        .getByText("Ended manual on-demand recording.", { exact: true }),
    ).toHaveCount(0);
    await stop.click();
    await expect(
      page
        .locator("#pageRoot")
        .getByText("Ended manual on-demand recording.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Start on-demand recording",
        exact: true,
      }),
    ).toBeVisible();
    expect(stops).toBe(2);
  });

  test("pending start prevents duplicate recording events", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    let starts = 0;
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/api/events/front_door/on_demand/create",
      async (route) => {
        starts++;
        await responseReady;
        await route.fulfill({
          json: { success: true, event_id: "manual-regression" },
        });
      },
    );
    await page.route("**/api/events/manual-regression/end", (route) =>
      route.fulfill({ json: { success: true } }),
    );
    try {
      await frigateApp.goto("/#front_door");
      const start = page.getByRole("button", {
        name: "Start on-demand recording",
        exact: true,
      });
      await start.click();
      await expect.poll(() => starts).toBe(1);
      await expect(start).toBeDisabled();
      release();
      await expect(
        page.getByRole("button", {
          name: /^(Stop|End on-demand recording)$/,
        }),
      ).toBeVisible();
      expect(starts).toBe(1);
    } finally {
      release();
    }
  });
});

// idb-keyval's default database, where user preferences such as dashboard
// layouts are kept
async function idbPut(page: Page, entries: Record<string, unknown>) {
  await page.evaluate(
    (values) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onupgradeneeded = () => open.result.createObjectStore("keyval");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          for (const [key, value] of Object.entries(values)) {
            store.put(value, key);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    entries,
  );
}

async function idbKeys(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result
            .transaction("keyval", "readonly")
            .objectStore("keyval")
            .getAllKeys();
          request.onsuccess = () => resolve(request.result.map(String));
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

const GROUP_LAYOUTS = {
  "default-draggable-layout:admin": [
    { i: "front_door", x: 0, y: 0, w: 4, h: 3 },
  ],
  "outdoor-draggable-layout:admin": [{ i: "backyard", x: 0, y: 0, w: 4, h: 3 }],
};

async function deleteCameraGroup(page: Page, name: string) {
  await page.getByRole("button", { name: "Edit Camera Groups" }).click();
  const row = page
    .getByRole("dialog")
    .getByText(name, { exact: true })
    .locator("xpath=../..");
  // the row's icons are edit, then delete
  await row.locator("svg").nth(1).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete" })
    .click();
}

test.describe("Live camera group delete (UI86) @critical", () => {
  test(
    "deleting another group keeps the open group's layout",
    { tag: "@desktop-only" },
    async ({ frigateApp }) => {
      const { page } = frigateApp;
      await frigateApp.goto("/");
      await idbPut(page, GROUP_LAYOUTS);
      const saved = page.waitForResponse(/\/api\/config\/set/);
      await deleteCameraGroup(page, "outdoor");
      await saved;

      await expect
        .poll(() => idbKeys(page))
        .not.toContain("outdoor-draggable-layout:admin");
      expect(await idbKeys(page)).toContain("default-draggable-layout:admin");
    },
  );

  test.describe("when the save fails", () => {
    test.use({ expectedErrors: [/500.*\/api\/config\/set/] });

    test(
      "every layout is kept",
      { tag: "@desktop-only" },
      async ({ frigateApp }) => {
        const { page } = frigateApp;
        await page.route(/\/api\/config\/set/, (route) =>
          route.fulfill({ status: 500, json: { success: false } }),
        );
        await frigateApp.goto("/");
        await idbPut(page, GROUP_LAYOUTS);
        const saved = page.waitForResponse(/\/api\/config\/set/);
        await deleteCameraGroup(page, "outdoor");
        await saved;

        const keys = await idbKeys(page);
        expect(keys).toContain("default-draggable-layout:admin");
        expect(keys).toContain("outdoor-draggable-layout:admin");
      },
    );
  });
});
