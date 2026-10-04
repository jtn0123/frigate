/**
 * Fork: wall display mode (UI19, flag `kioskMode`).
 *
 * `/kiosk` shows live cameras with no sidebar, status bar or bottom bar,
 * steps through camera groups, grid pages or single cameras on a timer,
 * and lets a new alert take over the screen. Live's "Open as wall display"
 * button builds the link.
 *
 * Cycle timers run on Playwright's clock, so every test that waits for a
 * slide change fast-forwards instead of sleeping.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import {
  grantClipboardPermissions,
  readClipboard,
} from "../../helpers/clipboard";

type ReviewOptions = {
  id: string;
  camera?: string;
  severity?: "alert" | "detection";
  beforeSeverity?: "alert" | "detection";
  objects?: string[];
  type?: "new" | "update" | "end";
  /** Seconds before now that the alert started. */
  startedAgo?: number;
};

function reviewMessage({
  id,
  camera = "backyard",
  severity = "alert",
  beforeSeverity = severity,
  objects = ["person"],
  type = "new",
  startedAgo = 0,
}: ReviewOptions) {
  const segment = (current: string) => ({
    id,
    camera,
    severity: current,
    start_time: Date.now() / 1000 - startedAgo,
    end_time: null,
    thumb_path: `/media/frigate/clips/review/thumb-${camera}-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [`${id}-obj`],
      objects,
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
  });
  return { type, before: segment(beforeSeverity), after: segment(severity) };
}

/**
 * Send reviews until the takeover shows `camera`. The WS mock only has a
 * socket once the app connects, and the display takes over once per review
 * id, so resending is safe.
 */
async function sendUntilTakeover(
  frigateApp: FrigateApp,
  messages: ReviewOptions[],
  camera: string,
) {
  const takeover = frigateApp.page.getByTestId("kiosk-takeover");
  await expect(async () => {
    for (const message of messages) {
      frigateApp.ws.sendReview(reviewMessage(message));
    }
    await expect(takeover).toHaveAttribute("data-camera", camera, {
      timeout: 1_000,
    });
  }).toPass({ timeout: 10_000 });
}

async function openKiosk(frigateApp: FrigateApp, query: string) {
  await frigateApp.page.clock.install();
  await frigateApp.goto(`/kiosk${query}`);
  await expect(frigateApp.page.getByTestId("kiosk")).toBeVisible();
}

function stage(page: Page) {
  return page.getByTestId("kiosk-stage");
}

function tiles(scope: Page | Locator) {
  return scope.getByTestId("kiosk-tile");
}

test.describe("Wall display @high", () => {
  test("shows the cameras with a clock and no app chrome @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?clock=1");

    await expect(tiles(page)).toHaveCount(3);
    await expect(tiles(page).nth(0)).toHaveAttribute(
      "data-camera",
      "front_door",
    );
    await expect(page.getByTestId("kiosk-tile-name").nth(0)).toBeVisible();
    await expect(page.getByTestId("kiosk-clock")).toBeVisible();
    await expect(page.getByTestId("kiosk-clock")).toHaveText(/\d{1,2}:\d{2}/);
    await expect(page.locator("aside")).toHaveCount(0);
    await expect(page.locator('a[href="/review"]')).toHaveCount(0);
    await expect(page.getByTestId("status-alert-trigger")).toHaveCount(0);
    await expect(page).toHaveTitle("Wall display - Frigate");

    // the controls and the cursor hide when idle and return on activity
    const controls = page.getByTestId("kiosk-controls");
    await expect(controls).toHaveAttribute("data-visible", "true");
    await page.clock.fastForward(3_000);
    await expect(controls).toHaveAttribute("data-visible", "false");
    await expect(page.getByTestId("kiosk")).toHaveAttribute(
      "data-idle",
      "true",
    );
    await page.mouse.move(200, 200);
    await expect(controls).toHaveAttribute("data-visible", "true");
  });

  test("cycles through groups and grid pages", async ({ frigateApp }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?group=default,outdoor&tiles=2&cycle=60");

    const position = page.getByTestId("kiosk-position");
    await expect(stage(page)).toHaveAttribute("data-source", "default");
    await expect(tiles(page)).toHaveCount(2);
    await expect(position).toHaveText("1 / 3");
    await expect(page.getByTestId("kiosk-progress")).toBeVisible();

    await page.clock.fastForward(60_000);
    await expect(position).toHaveText("2 / 3");
    await expect(stage(page)).toHaveAttribute("data-source", "default");
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page)).toHaveAttribute("data-camera", "garage");

    await page.clock.fastForward(60_000);
    await expect(position).toHaveText("3 / 3");
    await expect(stage(page)).toHaveAttribute("data-source", "outdoor");
    await expect(tiles(page)).toHaveCount(2);

    await page.clock.fastForward(60_000);
    await expect(position).toHaveText("1 / 3");
  });

  test("the controls fit a phone with the position on one line @mobile-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?group=default,outdoor&cycle=60");

    const position = page.getByTestId("kiosk-position");
    await expect(position).toHaveText("1 / 2");
    // one line of text-xs: "1 /" and "2" used to wrap onto two
    const line = await position.boundingBox();
    expect(line?.height).toBeLessThan(20);

    const bar = await page.getByTestId("kiosk-controls").boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(bar?.x).toBeGreaterThanOrEqual(0);
    expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(width);
  });

  test("single mode steps with the arrows and space pauses cycling @desktop-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?mode=single&cycle=60");

    const tile = tiles(page);
    await expect(stage(page)).toHaveAttribute("data-mode", "single");
    await expect(tile).toHaveCount(1);
    await expect(tile).toHaveAttribute("data-camera", "front_door");

    await page.keyboard.press("ArrowRight");
    await expect(tile).toHaveAttribute("data-camera", "backyard");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(tile).toHaveAttribute("data-camera", "garage");

    await page.keyboard.press(" ");
    await expect(page.getByTestId("kiosk-paused")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resume cycling" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("kiosk-progress")).toHaveCount(0);
    await page.clock.fastForward(180_000);
    await expect(tile).toHaveAttribute("data-camera", "garage");

    await page.keyboard.press(" ");
    await expect(page.getByTestId("kiosk-paused")).toHaveCount(0);
    await page.clock.fastForward(60_000);
    await expect(tile).toHaveAttribute("data-camera", "front_door");
  });

  test("Esc shows a hint first and a second Esc returns to Live @desktop-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "");

    const hint = page.getByTestId("kiosk-exit-hint");
    await page.keyboard.press("Escape");
    await expect(hint).toHaveText("Press Esc again to return to Live");
    // the hint expires, so a stray Esc much later only shows it again
    await page.clock.fastForward(3_000);
    await expect(hint).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(hint).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("kiosk")).toHaveCount(0);
    await expect(page.locator("aside")).toBeVisible();
  });

  test("a new alert takes over the screen and holds the cycle", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?group=default,outdoor&cycle=60&alerts=1");
    const takeover = page.getByTestId("kiosk-takeover");
    const position = page.getByTestId("kiosk-position");

    // Each message uses one review id, so a message that wrongly took over
    // would mark the id as seen and the alert after it would never show.
    // garage is shown (default group), so use a camera the display lacks.
    await sendUntilTakeover(
      frigateApp,
      [
        { id: "shared", camera: "attic" },
        { id: "shared", severity: "detection", objects: ["car"] },
        // an alert that was running before the display opened
        { id: "shared", type: "update", objects: ["dog"], startedAgo: 60 },
        { id: "shared", objects: ["person"] },
      ],
      "backyard",
    );
    await expect(takeover.getByRole("alert")).toContainText("Alert");
    await expect(page.getByTestId("kiosk-takeover-labels")).toHaveText(
      "Person",
    );
    await expect(takeover.getByTestId("kiosk-tile")).toHaveAttribute(
      "data-camera",
      "backyard",
    );
    await expect(page.getByTestId("kiosk-takeover-more")).toHaveCount(0);
    // the grid under it stops instead of streaming unseen (and the alerting
    // camera twice), and keeps its place
    await expect(tiles(stage(page))).toHaveCount(0);
    await expect(stage(page)).toHaveAttribute("data-source", "default");

    // the cycle waits for the takeover and then gives the slide a full turn
    await page.clock.fastForward(19_000);
    await expect(takeover).toBeVisible();
    await expect(position).toHaveText("1 / 2");
    await page.clock.fastForward(1_000);
    await expect(takeover).toHaveCount(0);
    await expect(position).toHaveText("1 / 2");
    await expect(tiles(stage(page))).toHaveCount(3);
    await page.clock.fastForward(60_000);
    await expect(position).toHaveText("2 / 2");

    // a detection upgraded to an alert takes over too, and Esc dismisses it
    await sendUntilTakeover(
      frigateApp,
      [
        {
          id: "upgraded",
          camera: "front_door",
          type: "update",
          beforeSeverity: "detection",
        },
      ],
      "front_door",
    );
    await page.keyboard.press("Escape");
    await expect(takeover).toHaveCount(0);
    await expect(page.getByTestId("kiosk-exit-hint")).toHaveCount(0);

    // manual and audio alerts start with an update, not a "new" message
    await sendUntilTakeover(
      frigateApp,
      [{ id: "update-first", camera: "front_door", type: "update" }],
      "front_door",
    );
    await expect(takeover.getByRole("alert")).toContainText("Alert");
  });

  test("alerts that start together take turns @desktop-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?group=default,outdoor&cycle=60&alerts=1");
    const takeover = page.getByTestId("kiosk-takeover");
    const more = page.getByTestId("kiosk-takeover-more");
    const labels = page.getByTestId("kiosk-takeover-labels");
    const position = page.getByTestId("kiosk-position");
    await expect(tiles(stage(page))).toHaveCount(3);

    // the first to arrive shows first and says another one waits
    await sendUntilTakeover(
      frigateApp,
      [
        { id: "walk-1", camera: "backyard" },
        { id: "walk-2", camera: "front_door", objects: ["car"] },
      ],
      "backyard",
    );
    await expect(labels).toHaveText("Person");
    await expect(more).toHaveText("+1 more alert");
    await expect(tiles(stage(page))).toHaveCount(0);

    // Esc ends only the alert showing; the next one gets a full turn
    await page.clock.fastForward(5_000);
    await page.keyboard.press("Escape");
    await expect(takeover).toHaveAttribute("data-camera", "front_door");
    await expect(labels).toHaveText("Car");
    await expect(more).toHaveCount(0);
    await expect(page.getByTestId("kiosk-exit-hint")).toHaveCount(0);

    // the cycle stays held until the last alert ends
    await page.clock.fastForward(19_000);
    await expect(takeover).toHaveAttribute("data-camera", "front_door");
    await expect(position).toHaveText("1 / 2");
    await page.clock.fastForward(1_000);
    await expect(takeover).toHaveCount(0);
    await expect(position).toHaveText("1 / 2");
    await expect(tiles(stage(page))).toHaveCount(3);

    // neither review takes over again; a new one does, alone
    await sendUntilTakeover(
      frigateApp,
      [
        { id: "walk-1", camera: "backyard" },
        { id: "walk-2", camera: "front_door", objects: ["car"] },
        { id: "walk-3", camera: "garage", objects: ["dog"] },
      ],
      "garage",
    );
    await expect(labels).toHaveText("Dog");
    await expect(more).toHaveCount(0);
  });

  test("keeps the session alive while it only streams", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?mode=single");
    await expect(tiles(page)).toHaveCount(1);

    // Nothing else asks the API while one camera streams, so the display
    // reads the profile every 10 minutes and the response renews the
    // session cookie before it expires.
    let reads = 0;
    page.on("request", (request) => {
      if (/\/api\/profile$/.test(request.url())) reads += 1;
    });
    await page.clock.fastForward(590_000);
    expect(reads).toBe(0);
    await page.clock.fastForward(10_000);
    await expect.poll(() => reads).toBe(1);
    await page.clock.fastForward(600_000);
    await expect.poll(() => reads).toBe(2);
  });

  test("Live's wall display button builds the link and opens it @desktop-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await grantClipboardPermissions(page.context());
    await frigateApp.goto("/");

    await page.getByTestId("kiosk-launch").click();
    const dialog = page.getByTestId("kiosk-setup");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("All cameras")).toBeVisible();
    const url = page.getByTestId("kiosk-setup-url");
    await expect(url).toHaveValue(/\/kiosk\?group=default$/);

    await dialog.getByLabel("Outdoor").check();
    await dialog.locator("#kiosk-cycle").click();
    await page.getByRole("option", { name: "30 seconds" }).click();
    await dialog.getByLabel("Show a clock").click();
    await dialog.getByLabel("Alert takeover").click();
    const query = "/kiosk?group=default,outdoor&cycle=30&clock=1&alerts=1";
    await expect(url).toHaveValue(new RegExp(`${escape(query)}$`));
    // the field wraps, so the options at the end of the link stay in view
    expect(
      await url.evaluate(
        (field) =>
          field.scrollWidth <= field.clientWidth &&
          field.scrollHeight <= field.clientHeight,
      ),
    ).toBe(true);

    // no group: nothing to open
    await dialog.getByLabel("All cameras").uncheck();
    await dialog.getByLabel("Outdoor").uncheck();
    await expect(dialog.getByText("Pick at least one group.")).toBeVisible();
    await expect(page.getByTestId("kiosk-setup-open")).toBeDisabled();
    await dialog.getByLabel("All cameras").check();
    await dialog.getByLabel("Outdoor").check();

    await dialog.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByText("Link copied")).toBeVisible();
    expect(await readClipboard(page)).toBe(await url.inputValue());

    await page.getByTestId("kiosk-setup-open").click();
    await expect(page).toHaveURL(new RegExp(`${escape(query)}$`));
    await expect(page.getByTestId("kiosk-clock")).toBeVisible();
    await expect(tiles(page)).toHaveCount(3);
    await expect(page.locator("aside")).toHaveCount(0);
  });

  test("the phone Live header opens the setup dialog @mobile-only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.clock.install();
    await frigateApp.goto("/");
    await page.getByTestId("kiosk-launch").click();
    const dialog = page.getByTestId("kiosk-setup");
    await expect(dialog).toBeVisible();
    await dialog.getByText("One camera").click();
    await expect(page.getByTestId("kiosk-setup-url")).toHaveValue(
      /\/kiosk\?group=default&mode=single$/,
    );
    // grid-only options leave with the grid
    await expect(dialog.locator("#kiosk-tiles")).toHaveCount(0);
    await page.getByTestId("kiosk-setup-open").click();
    await expect(stage(page)).toHaveAttribute("data-mode", "single");
    await expect(tiles(page)).toHaveCount(1);

    // a tap brings the controls back on a touch screen
    await page.clock.fastForward(3_000);
    const controls = page.getByTestId("kiosk-controls");
    await expect(controls).toHaveAttribute("data-visible", "false");
    await stage(page).tap();
    await expect(controls).toHaveAttribute("data-visible", "true");
    await controls.getByRole("button", { name: "Next" }).tap();
    await expect(tiles(page)).toHaveAttribute("data-camera", "backyard");
  });

  test("a link naming no cameras explains itself and leads back to Live @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await openKiosk(frigateApp, "?group=nope");
    const empty = page.getByTestId("kiosk-empty");
    await expect(empty).toContainText("Nothing to show");
    await empty.getByRole("button", { name: "Back to Live" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("kiosk")).toHaveCount(0);
  });

  test("with the flag off /kiosk is not a route @mobile", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await page.addInitScript(() => {
      localStorage.setItem("frigateFork", JSON.stringify({ kioskMode: false }));
    });
    await frigateApp.goto("/kiosk?group=outdoor");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("kiosk")).toHaveCount(0);
    await expect(page.getByTestId("kiosk-launch")).toHaveCount(0);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
