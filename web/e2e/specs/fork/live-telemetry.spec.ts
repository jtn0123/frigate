/**
 * Fork (UI146): live telemetry cards at the top of System > General.
 *
 * Incoming bitrate (go2rtc's measured receive rate, summed), active viewers
 * (the distinct clients among go2rtc's consumers, without Frigate's own
 * readers) and each detector's latency, with a per-camera table below. A
 * camera Frigate reads directly is flagged instead of counted as zero. On a
 * phone the figures are one compact row and the table starts closed.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect, type FrigateApp } from "../../fixtures/frigate-test";
import { BASE_CONFIG } from "../../fixtures/mock-data/config";
import {
  go2rtcStreamsFactory,
  type Go2rtcStreamReaders,
} from "../../fixtures/mock-data/fork-go2rtc-streams";

const LATENCY_KEYS = "detectors.inference_speed,service.last_updated";

const restream = (name: string) => `rtsp://127.0.0.1:8554/${name}`;

/** The fixture's ffmpeg input with another path. */
function inputs(...paths: string[]) {
  const base = BASE_CONFIG.cameras.front_door.ffmpeg.inputs[0];
  return paths.map((path) => ({ ...base, path }));
}

type TelemetryOptions = {
  latency?: Record<string, number>;
  go2rtcDown?: boolean;
  /** Every camera read directly, none through go2rtc. */
  direct?: boolean;
  readers?: Record<string, Go2rtcStreamReaders>;
};

const NOT_IN_GO2RTC = {
  configured: false,
  connected: false,
  bytes_received: 0,
  bytes_per_second: null,
  consumers: 0,
  codecs: [],
};

/**
 * front_door reads the restream, backyard reads it for detect and the camera
 * directly for record, and garage does not go through go2rtc at all. With
 * `direct`, none of the three goes through go2rtc.
 */
async function installTelemetry(
  frigateApp: FrigateApp,
  {
    latency = { coral: 8.6 },
    go2rtcDown = false,
    direct = false,
    readers = {
      front_door: { internal: 2, viewers: ["webrtc", "mse"] },
      backyard: { internal: 1, viewers: ["rtsp"] },
    },
  }: TelemetryOptions = {},
) {
  const go2rtcCameras = direct
    ? {
        front_door: [NOT_IN_GO2RTC],
        backyard: [NOT_IN_GO2RTC],
        garage: [NOT_IN_GO2RTC],
      }
    : {
        front_door: [{ bytes_per_second: 512_000, codecs: ["H265", "AAC"] }],
        backyard: [{ bytes_per_second: 256_000 }],
        garage: [NOT_IN_GO2RTC],
      };

  await frigateApp.installDefaults({
    config: direct
      ? {}
      : {
          cameras: {
            front_door: {
              ffmpeg: { inputs: inputs(restream("front_door")) },
            },
            backyard: {
              ffmpeg: {
                inputs: inputs(
                  restream("backyard"),
                  "rtsp://10.0.0.2:554/main",
                ),
              },
            },
          },
        },
    go2rtcState: go2rtcDown ? { available: false } : { cameras: go2rtcCameras },
  });

  await frigateApp.page.route("**/api/go2rtc/streams", (route) =>
    go2rtcDown
      ? route.fulfill({
          status: 500,
          json: { success: false, message: "Error fetching stream data" },
        })
      : route.fulfill({ json: go2rtcStreamsFactory(direct ? {} : readers) }),
  );

  // Only the latency card's read; the graphs below keep the fixture's.
  await frigateApp.page.route("**/api/stats/history**", (route) => {
    const keys = new URL(route.request().url()).searchParams.get("keys");
    if (keys !== LATENCY_KEYS) {
      return route.fallback();
    }
    const now = Date.now() / 1000;
    return route.fulfill({
      json: Array.from({ length: 12 }, (_, i) => ({
        service: { last_updated: now - (11 - i) * 15 },
        detectors: Object.fromEntries(
          Object.entries(latency).map(([name, ms]) => [
            name,
            { inference_speed: i === 11 ? ms : ms + ((i % 3) - 1) * 0.4 },
          ]),
        ),
      })),
    });
  });
}

/** A value usePersistence keeps in idb-keyval's store. */
async function readPersisted(page: Page, key: string) {
  return page.evaluate(async (target) => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("keyval-store", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("keyval");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction("keyval", "readonly");
        const get = tx.objectStore("keyval").get(target);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
    });
  }, key);
}

async function openGeneral(frigateApp: FrigateApp) {
  await frigateApp.goto("/system#general");
  await expect(frigateApp.page.getByTestId("live-telemetry")).toBeVisible({
    timeout: 10_000,
  });
}

/** The per-camera table, opened on a phone where it starts closed. */
async function openCameraTable(frigateApp: FrigateApp) {
  const toggle = frigateApp.page.getByTestId("live-camera-toggle");
  if (frigateApp.isMobile) {
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** Where an element is on the page; it must be laid out. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** The line that says how many cameras are measured, in either layout. */
function coverageNote(frigateApp: FrigateApp) {
  const page = frigateApp.page;
  return frigateApp.isMobile
    ? page.getByTestId("live-compact").getByTestId("live-compact-note")
    : page.getByTestId("live-bitrate").getByTestId("live-bitrate-note");
}

test.describe("Live telemetry (UI146) @medium @mobile", () => {
  test("sums go2rtc's bitrate and counts only people as viewers", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp);
    await openGeneral(frigateApp);
    const page = frigateApp.page;

    const dot = page.getByTestId("live-dot");
    await expect(dot).toHaveAttribute("data-state", "ready");
    await expect(dot).toHaveAccessibleName("Live: the figures are updating");
    await expect(dot.getByTestId("live-dot-ping")).toHaveCount(1);

    const bitrate = page.getByTestId("live-bitrate");
    // 512000 + 256000 bytes per second
    await expect(bitrate.getByTestId("live-value")).toHaveText("6.1 Mbit/s");
    await expect(coverageNote(frigateApp)).toHaveText(
      "2 of 3 cameras measured through go2rtc",
    );

    const viewers = page.getByTestId("live-viewers");
    await expect(viewers.getByTestId("live-value")).toHaveText("3");

    if (frigateApp.isMobile) {
      // the phone row keeps the numbers; the breakdowns are the cards'
      await expect(
        page.getByTestId("live-latency").getByTestId("live-value"),
      ).toHaveText("8.6 ms");
    } else {
      await expect(viewers.getByTestId("live-viewers-breakdown")).toHaveText(
        "3 streams: 1 WebRTC, 1 MSE, 1 RTSP",
      );
      await expect(viewers.getByTestId("live-viewers-internal")).toHaveText(
        "Not counted: 3 Frigate readers",
      );

      const coral = page.getByTestId("live-latency-coral");
      await expect(coral).toHaveAttribute("data-level", "ok");
      await expect(coral).toContainText("8.6 ms");
      await expect(page.getByTestId("live-latency-note")).toHaveText(
        "Warning above 50 ms",
      );
    }
  });

  test("counts one browser watching two cameras as one viewer", async ({
    frigateApp,
  }) => {
    // the Live dashboard in one browser: an MSE player per camera
    const browser = { kind: "mse", client: "192.168.1.40" } as const;
    await installTelemetry(frigateApp, {
      readers: {
        front_door: { internal: 1, viewers: [browser] },
        backyard: { internal: 1, viewers: [browser] },
      },
    });
    await openGeneral(frigateApp);
    const page = frigateApp.page;

    const viewers = page.getByTestId("live-viewers");
    await expect(viewers.getByTestId("live-value")).toHaveText("1");
    if (!frigateApp.isMobile) {
      await expect(viewers.getByTestId("live-viewers-breakdown")).toHaveText(
        "2 streams: 2 MSE",
      );
    }

    // the table counts each camera's streams
    await openCameraTable(frigateApp);
    for (const camera of ["front_door", "backyard"]) {
      await expect(
        page
          .getByTestId(`live-camera-${camera}`)
          .getByTestId("live-camera-streams"),
      ).toHaveText("1");
    }
  });

  test("flags a camera that does not go through go2rtc", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp);
    await openGeneral(frigateApp);
    await openCameraTable(frigateApp);
    const page = frigateApp.page;

    const front = page.getByTestId("live-camera-front_door");
    await expect(front).toHaveAttribute("data-status", "measured");
    await expect(front).toContainText("4.1 Mbit/s");
    await expect(front.getByTestId("live-camera-streams")).toHaveText("2");

    const backyard = page.getByTestId("live-camera-backyard");
    await expect(backyard).toHaveAttribute("data-status", "partial");
    await expect(backyard).toContainText("Partial");

    const garage = page.getByTestId("live-camera-garage");
    await expect(garage).toHaveAttribute("data-status", "notMeasured");
    await expect(garage).toContainText("Not measured");
    await expect(garage.getByTestId("live-camera-streams")).toHaveText("-");
    await expect(page.getByTestId("live-not-measured-note")).toBeVisible();
  });

  test("tints the latency card when a detector is slow", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp, {
      latency: { coral: 9.1, cpu: 84.3 },
    });
    await openGeneral(frigateApp);
    const page = frigateApp.page;

    if (frigateApp.isMobile) {
      // the phone row shows the slowest detector, tinted the same way
      const latency = page.getByTestId("live-latency");
      await expect(latency).toHaveAttribute("data-level", "warning");
      await expect(latency.getByTestId("live-value")).toHaveText("84.3 ms");
      return;
    }

    await expect(page.getByTestId("live-latency-coral")).toHaveAttribute(
      "data-level",
      "ok",
    );
    const cpu = page.getByTestId("live-latency-cpu");
    await expect(cpu).toHaveAttribute("data-level", "warning");
    await expect(cpu).toContainText("CPU");
    await expect(cpu).toContainText("84.3 ms");
    await expect(page.getByTestId("live-latency-note")).toHaveText(
      "Slower than 50 ms: detections can lag or frames get skipped",
    );
  });

  test("shows a dash, not a wait, when no camera goes through go2rtc", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp, { direct: true });
    await openGeneral(frigateApp);
    const page = frigateApp.page;

    const bitrate = page.getByTestId("live-bitrate");
    await expect(coverageNote(frigateApp)).toHaveText(
      "0 of 3 cameras measured through go2rtc",
    );
    await expect(bitrate.getByTestId("live-value")).toHaveText("-");
    const viewers = page.getByTestId("live-viewers");
    await expect(viewers.getByTestId("live-value")).toHaveText("-");
    if (!frigateApp.isMobile) {
      await expect(viewers.getByTestId("live-viewers-breakdown")).toHaveText(
        "No camera goes through go2rtc, so viewers are not seen",
      );
    }
    await openCameraTable(frigateApp);
    await expect(page.getByTestId("live-camera-garage")).toHaveAttribute(
      "data-status",
      "notMeasured",
    );
  });

  test("adds a sparkline point for every new go2rtc read", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp);
    await openGeneral(frigateApp);
    const page = frigateApp.page;

    // the go2rtc mock stamps every answer with the time it was asked, so each
    // five second poll is a new sample. The card draws its sparkline from the
    // second one; a phone has only the table's.
    let sparkline = page.getByTestId("live-bitrate").getByTestId("sparkline");
    if (frigateApp.isMobile) {
      await openCameraTable(frigateApp);
      sparkline = page
        .getByTestId("live-camera-front_door")
        .getByTestId("sparkline");
    }
    await expect(sparkline).toHaveAttribute(
      "data-points",
      /^(?:[2-9]|\d{2,})$/,
      { timeout: 15_000 },
    );
  });

  test("remembers the camera table being opened or closed", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp);
    await openGeneral(frigateApp);
    const page = frigateApp.page;
    // open on a desktop, closed on a phone, until the user picks
    const open = !frigateApp.isMobile;

    const toggle = page.getByTestId("live-camera-toggle");
    await expect(toggle).toHaveText("Per camera (3)");
    await expect(toggle).toHaveAttribute("aria-expanded", String(open));
    await expect(page.getByTestId("live-camera-table")).toHaveCount(
      open ? 1 : 0,
    );
    await toggle.click();
    await expect(page.getByTestId("live-camera-table")).toHaveCount(
      open ? 0 : 1,
    );
    // the choice is written to IndexedDB after the click; reload once it is
    await expect
      .poll(() => readPersisted(page, "live-telemetry-per-camera"))
      .toBe(!open);

    await page.reload();
    await expect(page.getByTestId("live-camera-toggle")).toHaveAttribute(
      "aria-expanded",
      String(!open),
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("live-camera-table")).toHaveCount(
      open ? 0 : 1,
    );
  });

  test("is off with its fork flag", async ({ frigateApp }) => {
    await frigateApp.page.addInitScript(() => {
      localStorage.setItem(
        "frigateFork",
        JSON.stringify({ liveTelemetry: false }),
      );
    });
    await frigateApp.goto("/system#general");

    await expect(
      frigateApp.page.getByText("Detector Inference Speed", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(frigateApp.page.getByTestId("live-telemetry")).toHaveCount(0);
  });
});

test.describe("Live telemetry without go2rtc (UI146) @medium @mobile", () => {
  test.use({
    expectedErrors: [
      /500.*\/api\/go2rtc\/streams|Failed to load resource.*500/,
    ],
  });

  test("says go2rtc is unreachable instead of showing zero", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp, { go2rtcDown: true });
    await openGeneral(frigateApp);
    const page = frigateApp.page;

    await expect(
      page.getByTestId("live-bitrate").getByTestId("live-value"),
    ).toHaveText("-");
    await expect(coverageNote(frigateApp)).toHaveText(
      "go2rtc is not reachable, so nothing can be measured right now.",
    );
    await expect(
      page.getByTestId("live-viewers").getByTestId("live-value"),
    ).toHaveText("-");
    // the Live dot stops pulsing and says why, instead of staying green
    const dot = page.getByTestId("live-dot");
    await expect(dot).toHaveAttribute("data-state", "unavailable");
    await expect(dot).toHaveAccessibleName("Paused: go2rtc is not reachable");
    await expect(dot.getByTestId("live-dot-ping")).toHaveCount(0);
    await openCameraTable(frigateApp);
    await expect(page.getByTestId("live-camera-unavailable")).toBeVisible();
    // the cards say it; no read-error toast on top
    await expect(
      page.locator('[data-sonner-toast][data-type="error"]'),
    ).toHaveCount(0);
  });
});

test.describe("Live telemetry on a phone (UI146) @medium @mobile-only", () => {
  test("keeps the figures to one row so the graphs stay in reach", async ({
    frigateApp,
  }) => {
    await installTelemetry(frigateApp);
    await openGeneral(frigateApp);
    const page = frigateApp.page;
    const section = page.getByTestId("live-telemetry");

    const compact = section.getByTestId("live-compact");
    const bitrate = compact.getByTestId("live-bitrate");
    const viewers = compact.getByTestId("live-viewers");
    const latency = compact.getByTestId("live-latency");
    await expect(bitrate.getByTestId("live-value")).toHaveText("6.1 Mbit/s");
    await expect(viewers.getByTestId("live-value")).toHaveText("3");
    await expect(latency.getByTestId("live-value")).toHaveText("8.6 ms");

    // one row: the three figures start on the same line, side by side
    const [first, second, third] = await Promise.all([
      boxOf(bitrate),
      boxOf(viewers),
      boxOf(latency),
    ]);
    expect(Math.abs(second.y - first.y)).toBeLessThan(1);
    expect(Math.abs(third.y - first.y)).toBeLessThan(1);
    expect(first.x).toBeLessThan(second.x);
    expect(second.x).toBeLessThan(third.x);

    // no sparklines and no table until asked for
    await expect(section.getByTestId("sparkline")).toHaveCount(0);
    await expect(page.getByTestId("live-camera-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // a few lines tall (it was about 800 px), so the graphs' range control
    // is on the first screen at 412 x 915
    const height = (await section.boundingBox())?.height ?? Infinity;
    expect(height).toBeLessThan(260);
    await expect(page.getByTestId("metric-range")).toBeInViewport();
  });
});
