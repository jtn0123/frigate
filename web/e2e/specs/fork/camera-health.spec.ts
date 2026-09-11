/**
 * Fork: camera health cards (UI item 12).
 *
 * The System page gains a "Health" tab with one card per enabled camera,
 * classified ok / degraded / offline from the stats stream, with an inline
 * SVG sparkline of camera fps built from successive stats updates.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";

type CameraOverride = Partial<{
  camera_fps: number;
  detection_fps: number;
  process_fps: number;
  skipped_fps: number;
  connection_quality: "excellent" | "fair" | "poor" | "unusable";
  expected_fps: number;
  reconnects_last_hour: number;
  stalls_last_hour: number;
  hwaccel_fallback: boolean;
}>;

function sendStats(
  frigateApp: FrigateApp,
  lastUpdated: number,
  overrides: Record<string, CameraOverride> = {},
) {
  const camera = (name: string) => ({
    camera_fps: 5,
    detection_fps: 5,
    process_fps: 5,
    skipped_fps: 0,
    detection_enabled: 1,
    connection_quality: "excellent",
    expected_fps: 5,
    reconnects_last_hour: 0,
    stalls_last_hour: 0,
    ...(overrides[name] ?? {}),
  });
  frigateApp.ws.send(
    "stats",
    JSON.stringify({
      cameras: {
        front_door: camera("front_door"),
        backyard: camera("backyard"),
        garage: camera("garage"),
      },
      service: {
        last_updated: lastUpdated,
        uptime: 86400,
        version: "0.15.0-test",
        latest_version: "0.15.0",
        storage: {},
      },
      detectors: {},
      cpu_usages: {},
      gpu_usages: {},
      processes: {},
      camera_fps: 15,
      process_fps: 15,
      skipped_fps: 0,
      detection_fps: 15,
    }),
  );
}

async function gotoHealth(frigateApp: FrigateApp) {
  await frigateApp.goto("/system#health");
  await expect(frigateApp.page.getByLabel("Select health")).toHaveAttribute(
    "data-state",
    "on",
    { timeout: 15_000 },
  );
  await expect(frigateApp.page.getByTestId("camera-health-grid")).toBeVisible();
}

test.describe("Camera health cards @high", () => {
  test("health tab renders one card per camera in the ok state", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    for (const name of ["front_door", "backyard", "garage"]) {
      const card = frigateApp.page.getByTestId(`camera-health-${name}`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-state", "ok");
      await expect(card.getByText("OK", { exact: true })).toBeVisible();
    }
    const front = frigateApp.page.getByTestId("camera-health-front_door");
    await expect(front.getByText("Front Door")).toBeVisible();
    await expect(front.getByText("Camera FPS", { exact: true })).toBeVisible();
    await expect(front.getByText("Detector share")).toBeVisible();
  });

  test("cards link to the live view and camera settings", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const card = frigateApp.page.getByTestId("camera-health-garage");
    await expect(card.locator('a[href="/#garage"]')).toBeVisible();
    await expect(
      card.locator('a[href="/settings?page=cameraFfmpeg&camera=garage"]'),
    ).toBeVisible();
  });

  test("zero fps marks a camera offline and skipped frames degraded", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        front_door: { camera_fps: 0, detection_fps: 0 },
        backyard: { skipped_fps: 2.5, reconnects_last_hour: 3 },
      });
      await expect(
        frigateApp.page.getByTestId("camera-health-front_door"),
      ).toHaveAttribute("data-state", "offline", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    const front = frigateApp.page.getByTestId("camera-health-front_door");
    await expect(front.getByText("Offline", { exact: true })).toBeVisible();
    await expect(front.getByTestId("camera-health-reason")).toHaveText(
      "No frames received",
    );

    const back = frigateApp.page.getByTestId("camera-health-backyard");
    await expect(back).toHaveAttribute("data-state", "degraded");
    await expect(back.getByTestId("camera-health-reason")).toContainText(
      "Frames are being skipped",
    );
    await expect(back.getByTestId("camera-health-reason")).toContainText(
      "FFmpeg reconnected in the last hour",
    );

    await expect(
      frigateApp.page.getByTestId("camera-health-garage"),
    ).toHaveAttribute("data-state", "ok");
  });

  test("a camera that fell back to software decoding is flagged (D10)", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    const garage = frigateApp.page.getByTestId("camera-health-garage");
    await expect(async () => {
      sendStats(frigateApp, now + 5, { garage: { hwaccel_fallback: true } });
      await expect(garage).toHaveAttribute("data-state", "degraded", {
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });

    await expect(garage.getByTestId("camera-health-reason")).toHaveText(
      "Hardware decoding kept failing, so detection decodes in software",
    );
    if (!frigateApp.isMobile) {
      await expect(
        frigateApp.page.getByText(
          "Garage: hardware decoding kept failing, now decoding in software",
        ),
      ).toBeVisible();
    }
  });

  test("sparkline grows with each stats update", async ({ frigateApp }) => {
    await gotoHealth(frigateApp);
    const spark = frigateApp.page
      .getByTestId("camera-health-front_door")
      .getByTestId("sparkline");
    await expect(spark).toBeVisible();
    const initial = Number(await spark.getAttribute("data-points"));
    const now = Date.now() / 1000;
    sendStats(frigateApp, now + 10, { front_door: { camera_fps: 4 } });
    sendStats(frigateApp, now + 20, { front_door: { camera_fps: 6 } });
    await expect
      .poll(async () => Number(await spark.getAttribute("data-points")), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(initial + 2);
    await expect(spark.locator("polyline")).toHaveCount(1);
  });

  test("health tab is reachable on a phone @mobile", async ({ frigateApp }) => {
    test.skip(!frigateApp.isMobile, "Mobile layout");
    await gotoHealth(frigateApp);
    await expect(
      frigateApp.page.getByTestId("camera-health-front_door"),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByTestId("camera-health-garage"),
    ).toBeVisible();
  });
});
