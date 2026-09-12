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
  hwaccel_fallback_since: number;
  restarts_24h: number;
  restart_kinds_24h: Record<string, number>;
  recent_restarts: Array<{
    time: number;
    role: string;
    kind: string;
    message: string;
  }>;
}>;

function sendStats(
  frigateApp: FrigateApp,
  lastUpdated: number,
  overrides: Record<string, CameraOverride> = {},
  uptime = 86400,
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
        uptime,
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

  test("zero fps marks a camera offline; only lasting trouble marks it degraded", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        front_door: { camera_fps: 0, detection_fps: 0 },
        backyard: {
          process_fps: 2.5,
          skipped_fps: 2.5,
          connection_quality: "poor",
          reconnects_last_hour: 3,
        },
        // D14: a blip is normal and shows only in the numbers
        garage: {
          process_fps: 4,
          skipped_fps: 1,
          connection_quality: "fair",
          reconnects_last_hour: 1,
          stalls_last_hour: 1,
        },
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
    await expect(back.getByTestId("camera-health-reason")).toHaveText(
      "Detection skips half of the frames or more, Poor connection quality",
    );

    const garage = frigateApp.page.getByTestId("camera-health-garage");
    await expect(garage).toHaveAttribute("data-state", "ok");
    await expect(garage.getByTestId("camera-health-reason")).toHaveCount(0);
  });

  test("right after a start, a camera without frames is starting, not offline (D14)", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    const front = frigateApp.page.getByTestId("camera-health-front_door");
    await expect(async () => {
      sendStats(
        frigateApp,
        now + 5,
        { front_door: { camera_fps: 0, detection_fps: 0 } },
        30,
      );
      await expect(front).toHaveAttribute("data-state", "starting", {
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });
    await expect(front.getByText("Starting", { exact: true })).toBeVisible();
    await expect(front.getByTestId("camera-health-reason")).toHaveCount(0);

    await expect(async () => {
      sendStats(
        frigateApp,
        now + 10,
        { front_door: { camera_fps: 0, detection_fps: 0 } },
        600,
      );
      await expect(front).toHaveAttribute("data-state", "offline", {
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });
  });

  test("software decoding is a note on the card and a status bar message for a day (D10, D14)", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    const garage = frigateApp.page.getByTestId("camera-health-garage");
    const note = garage.getByTestId("camera-health-note");
    const message = frigateApp.page.getByText(
      "Garage: hardware decoding kept failing, now decoding in software",
    );
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        garage: { hwaccel_fallback: true, hwaccel_fallback_since: now - 3600 },
      });
      await expect(note).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await expect(garage).toHaveAttribute("data-state", "ok");
    await expect(note).toHaveText(
      "Decodes in software because hardware decoding kept failing · 1h ago",
    );
    if (!frigateApp.isMobile) {
      await expect(message).toBeVisible();
    }

    // Two days later (and across restarts) the card keeps the note but the
    // status bar stops repeating it.
    await expect(async () => {
      sendStats(frigateApp, now + 10, {
        garage: {
          hwaccel_fallback: true,
          hwaccel_fallback_since: now - 2 * 86400,
        },
      });
      await expect(note).toContainText("2d ago", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await expect(message).toHaveCount(0);
  });

  test("feed restarts show as one collapsed line with the reasons (D11)", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const backyard = frigateApp.page.getByTestId("camera-health-backyard");
    await expect(backyard.getByTestId("camera-health-restarts")).toHaveCount(0);

    const now = Date.now() / 1000;
    const restarts = frigateApp.page
      .getByTestId("camera-health-front_door")
      .getByTestId("camera-health-restarts");
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        front_door: {
          restarts_24h: 3,
          restart_kinds_24h: { hwaccel: 2, connection: 1 },
          recent_restarts: [
            {
              time: now - 600,
              role: "detect",
              kind: "connection",
              message: "Connection refused",
            },
            {
              time: now - 120,
              role: "detect",
              kind: "hwaccel",
              message: "Failed to sync surface 0x3: 1 (operation failed).",
            },
          ],
        },
      });
      await expect(restarts).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await expect(restarts.locator("summary")).toHaveText(
      "3 feed restarts in the last 24 h (2 hardware decoding, 1 connection lost)",
    );
    const items = restarts.locator("li");
    await expect(items.first()).toBeHidden();
    await restarts.locator("summary").click();
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText("hardware decoding");
    await expect(items.first()).toContainText("Failed to sync surface");
    await expect(items.last()).toContainText("Connection refused");
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

  test("the frame-rate chart starts from the server's recent history", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const card = frigateApp.page.getByTestId("camera-health-front_door");
    const spark = card.getByTestId("sparkline");
    await expect
      .poll(async () => Number(await spark.getAttribute("data-points")), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(20);
    await expect(spark.locator("polyline")).toHaveCount(1);
    await expect(card.getByTestId("camera-health-chart-caption")).toHaveText(
      /^Frame rate, last \d+ minutes$/,
    );

    // The dashed target line and its legend follow the camera's expected fps.
    const now = Date.now() / 1000;
    await expect(async () => {
      sendStats(frigateApp, now + 5);
      await expect(card.getByText("target 5 fps")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });
    await expect(spark.getByTestId("sparkline-reference")).toHaveCount(1);
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
