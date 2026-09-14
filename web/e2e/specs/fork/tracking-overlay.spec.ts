/**
 * Fork: tracked-object overlay (UI64).
 *
 * The overlay draws an object's box only while the video is paused. Tapping
 * a moment in Tracking Details now pauses on it, so its box shows; with the
 * flag off the video keeps playing past the moment, as upstream does.
 */

import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";

// Recorded moments for whichever tracked object the dialog asks about
function moments(sourceId: string) {
  const moment = (timestamp: number, classType: string, box: number[]) => ({
    camera: "front_door",
    timestamp,
    class_type: classType,
    source_id: sourceId,
    source: "tracked_object",
    data: {
      camera: "front_door",
      label: "person",
      sub_label: "",
      score: 0.8,
      box,
      region: [0, 0, 1, 1],
      attribute: "",
      zones: [],
    },
  });
  return [
    moment(1780677010, "visible", [0.2, 0.2, 0.1, 0.3]),
    moment(1780677015, "gone", [0.6, 0.2, 0.1, 0.3]),
  ];
}

async function openTrackingDetails(frigateApp: FrigateApp) {
  const { page } = frigateApp;
  // Count pauses on any video, the only way to see a paused frame here:
  // the mocked recording is empty, so the box itself never draws
  await page.addInitScript(() => {
    const counter = window as unknown as { __pauses: number };
    counter.__pauses = 0;
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      counter.__pauses += 1;
      return pause.call(this);
    };
  });
  await page.route("**/api/timeline**", (route) => {
    const sourceId =
      new URL(route.request().url()).searchParams.get("source_id") ?? "";
    return route.fulfill({ json: moments(sourceId) });
  });

  await frigateApp.goto("/explore?labels=person");
  const firstResult = page.locator("[data-start]").first();
  await expect(firstResult).toBeVisible({ timeout: 10_000 });
  await firstResult.click();

  // A dialog on desktop, a full-screen page on phones, so not scoped to either
  await page.getByRole("radio", { name: "Select tracking details" }).click();
  const row = page.getByText("Person detected", { exact: true });
  await expect(row).toBeVisible();
  return row;
}

function pauses(frigateApp: FrigateApp) {
  return frigateApp.page.evaluate(
    () => (window as unknown as { __pauses: number }).__pauses,
  );
}

test.describe("Tracking overlay @high @mobile", () => {
  test("tapping a moment pauses the video on it", async ({ frigateApp }) => {
    const row = await openTrackingDetails(frigateApp);
    const before = await pauses(frigateApp);

    await row.click();
    await expect.poll(() => pauses(frigateApp)).toBeGreaterThan(before);
  });

  test("with the flag off the video keeps playing, as upstream", async ({
    frigateApp,
  }) => {
    await frigateApp.page.addInitScript(() => {
      localStorage.setItem("frigateFork", '{"trackOverlay":false}');
    });
    const row = await openTrackingDetails(frigateApp);
    const before = await pauses(frigateApp);

    await row.click();
    // two frames for the click handler and any effects it triggers
    await frigateApp.page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(await pauses(frigateApp)).toBe(before);
  });
});
