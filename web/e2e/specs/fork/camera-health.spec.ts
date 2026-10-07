/**
 * Fork: the System > Health tab (UI item 12, redesigned in UI131).
 *
 * One row per enabled camera, classified ok / degraded / offline from the
 * stats stream and measured against the window `/api/fork/camera_history` keeps.
 * Opening a row shows that camera's uptime strip, its incidents and the live
 * numbers behind its state.
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { FrigateApp } from "../../fixtures/frigate-test";
import { BASE_STATS } from "../../fixtures/mock-data/stats";
import type { CameraHistorySeriesMock } from "../../fixtures/mock-data/fork-camera-history";
import { UNREACHABLE_PING } from "../../fixtures/mock-data/fork-go2rtc-state";
import { openStatusIssues } from "../../helpers/status-issues";

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
        // Status updates must not be future-dated: the health view rejects them.
        last_updated: Math.min(lastUpdated, Date.now() / 1000),
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

/** A window where the garage was down for 14 minutes and restarted twice. */
function troubledHistory(
  now: number,
): Record<string, Partial<CameraHistorySeriesMock>> {
  return {
    front_door: {},
    backyard: {
      uptime: 99.2,
      // The collector appends incidents in time order, oldest first.
      incidents: [
        {
          kind: "restart:connection",
          start: now - 7200,
          end: now - 7175,
          reason: "Connection refused",
        },
        {
          kind: "restart:stalled",
          start: now - 3600,
          end: now - 3580,
          reason: "ffmpeg watchdog restarted the stream",
        },
      ],
    },
    garage: {
      uptime: 99,
      downtime: 840,
      states: Array.from({ length: 24 }, (_, i) =>
        i >= 22 ? ("offline" as const) : ("ok" as const),
      ),
      incidents: [
        {
          kind: "outage",
          start: now - 840,
          end: null,
          reason: "RTSP connect failed, connection refused",
        },
      ],
    },
  };
}

async function gotoHealth(
  frigateApp: FrigateApp,
  cameraHistory?: Record<string, Partial<CameraHistorySeriesMock>>,
) {
  if (cameraHistory) {
    await frigateApp.installDefaults({ cameraHistory });
  }
  await frigateApp.goto("/system#health");
  await expect(frigateApp.page.getByLabel("Select health")).toHaveAttribute(
    "data-state",
    "on",
    { timeout: 15_000 },
  );
  await expect(
    frigateApp.page.getByTestId("camera-health-table"),
  ).toBeVisible();
}

test.describe("Camera health table @high", () => {
  test("one row per camera, with the window's uptime beside the live rate", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    for (const name of ["front_door", "backyard", "garage"]) {
      const row = frigateApp.page.getByTestId(`camera-health-${name}`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-state", "ok");
      await expect(row.getByText("OK", { exact: true })).toBeVisible();
    }
    const front = frigateApp.page.getByTestId("camera-health-front_door");
    await expect(
      front.getByRole("button", { name: "Open Front Door" }),
    ).toBeVisible();
    await expect(front.getByText("100%")).toBeVisible();
    await expect(front.getByTestId("camera-health-issues")).toHaveText("clean");
    await expect(
      frigateApp.page.getByTestId("camera-health-summary"),
    ).toContainText("3 of 3 cameras captured cleanly in the last 24 hours.");
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

    await expect(
      frigateApp.page.getByTestId("camera-health-backyard"),
    ).toHaveAttribute("data-state", "degraded");
    await expect(
      frigateApp.page.getByTestId("camera-health-garage"),
    ).toHaveAttribute("data-state", "ok");

    // The worst camera sorts to the top, and the summary counts the rest.
    const rows = frigateApp.page.locator("tbody tr");
    await expect(rows.first()).toHaveAttribute("data-state", "offline");
    await expect(
      frigateApp.page.getByTestId("camera-health-summary"),
      // The garage's single stall and reconnect keep it off the clean count.
    ).toContainText("0 of 3 cameras captured cleanly");
  });

  test("the scope toggle keeps only the cameras that need a look", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        garage: { camera_fps: 0, detection_fps: 0 },
      });
      await expect(
        frigateApp.page.getByTestId("camera-health-garage"),
      ).toHaveAttribute("data-state", "offline", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await frigateApp.page
      .getByRole("radio", { name: "Needs attention · 1" })
      .click();
    await expect(frigateApp.page).toHaveURL(/scope=attention/);
    await expect(
      frigateApp.page.getByTestId("camera-health-garage"),
    ).toBeVisible();
    await expect(
      frigateApp.page.getByTestId("camera-health-front_door"),
    ).toHaveCount(0);

    await frigateApp.page.getByRole("radio", { name: "All · 3" }).click();
    await expect(
      frigateApp.page.getByTestId("camera-health-front_door"),
    ).toBeVisible();
  });

  test("a column header sorts the table both ways", async ({ frigateApp }) => {
    await gotoHealth(frigateApp);
    const names = frigateApp.page.locator("tbody tr td:first-child");
    const header = frigateApp.page.getByRole("button", {
      name: "Sort by Camera",
    });

    await header.click();
    await expect(names).toHaveText([/Backyard/, /Front Door/, /Garage/]);
    await header.click();
    await expect(names).toHaveText([/Garage/, /Front Door/, /Backyard/]);
  });

  test("clicking anywhere on a row opens that camera", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    // The hint above the table promises the whole row, not just the name, so
    // the row's overlay has to catch a click on a cell that carries no control
    // of its own. Clicked through the mouse rather than the state cell's own
    // locator: Playwright reads the overlay as intercepting that cell, which is
    // precisely the behavior under test.
    const state = frigateApp.page
      .getByTestId("camera-health-front_door")
      .locator("td")
      .nth(1);
    const box = await state.boundingBox();
    expect(box).not.toBeNull();
    await frigateApp.page.mouse.click(
      box!.x + box!.width / 2,
      box!.y + box!.height / 2,
    );
    await expect(
      frigateApp.page.getByTestId("camera-health-drawer"),
    ).toBeVisible();
    await expect(frigateApp.page).toHaveURL(/health=front_door/);
  });

  test("the range selector asks the backend for a different window", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    await expect(
      frigateApp.page.getByTestId("camera-health-summary"),
    ).toContainText("in the last 24 hours");

    await frigateApp.page.getByRole("radio", { name: "7 d" }).click();
    await expect(frigateApp.page).toHaveURL(/range=7d/);
    await expect(
      frigateApp.page.getByTestId("camera-health-summary"),
    ).toContainText("in the last 7 days");
    // The frame-rate column, and so its header, is desktop only.
    await expect(
      frigateApp.page.getByRole("button", { name: "Sort by Frame rate · 7 d" }),
    ).toHaveCount(frigateApp.isMobile ? 0 : 1);
  });

  test("the range and last-refreshed sit in the page header @mobile", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    // The range scales every number on the tab, so it belongs beside the page
    // title rather than above the table it happens to scale.
    const toolbar = frigateApp.page.getByTestId("camera-health-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(
      toolbar.getByRole("radio", { name: "24 h", checked: true }),
    ).toBeVisible();
    await expect(toolbar).toContainText("Last refreshed");
    // and not a second copy above the table
    await expect(
      frigateApp.page.getByRole("radio", { name: "24 h" }),
    ).toHaveCount(1);
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

  test("fresh stats remain usable between freshness timer ticks", async ({
    frigateApp,
  }) => {
    const start = new Date();
    await frigateApp.page.clock.install({ time: start });
    await gotoHealth(frigateApp);
    const updated = new Date(start.getTime() + 6000);
    await frigateApp.page.clock.pauseAt(updated);
    // a push that lands before the connect frame is overwritten by it, so
    // resend until it shows
    await expect(async () => {
      frigateApp.ws.send(
        "stats",
        JSON.stringify({
          ...BASE_STATS,
          service: {
            ...BASE_STATS.service,
            uptime: 600,
            last_updated: updated.getTime() / 1000,
          },
          cameras: {
            ...BASE_STATS.cameras,
            front_door: { ...BASE_STATS.cameras["front_door"], camera_fps: 0 },
          },
        }),
      );
      await expect(
        frigateApp.page.getByTestId("camera-health-front_door"),
      ).toHaveAttribute("data-state", "offline", { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
  });
});

test.describe("Camera health drawer @high", () => {
  test("a row opens the camera's window, its incidents and its live numbers", async ({
    frigateApp,
  }) => {
    const now = Math.floor(Date.now() / 1000);
    await gotoHealth(frigateApp, troubledHistory(now));
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        garage: { camera_fps: 0, detection_fps: 0, reconnects_last_hour: 9 },
      });
      await expect(
        frigateApp.page.getByTestId("camera-health-garage"),
      ).toHaveAttribute("data-state", "offline", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await frigateApp.page.getByRole("button", { name: "Open Garage" }).click();
    const drawer = frigateApp.page.getByTestId("camera-health-drawer");
    await expect(drawer).toBeVisible();
    await expect(frigateApp.page).toHaveURL(/health=garage/);

    await expect(drawer.getByText("99%")).toBeVisible();
    await expect(drawer.getByText("14 min")).toBeVisible();
    await expect(drawer.getByTestId("camera-health-reason")).toHaveText(
      "No frames received",
    );
    await expect(drawer.getByTestId("camera-health-metrics")).toContainText(
      "Reconnects (1h)",
    );

    // 24 h over 24 cells is an hour each, said in hours rather than "60 min".
    await expect(drawer).toContainText("1 cell = 1 hour");

    // Two of the 24 cells are the outage, the rest recorded.
    const cells = drawer.getByTestId("uptime-strip").locator("div");
    await expect(cells).toHaveCount(24);
    await expect(cells.filter({ hasNot: cells })).toHaveCount(24);
    await expect(drawer.locator('[data-state="offline"]')).toHaveCount(2);

    const incident = drawer.getByTestId("camera-health-incident");
    await expect(incident).toHaveCount(1);
    await expect(incident).toContainText("Outage");
    await expect(incident).toContainText("still going");
    await expect(incident).toContainText("RTSP connect failed");

    await expect(drawer.locator('a[href="/#garage"]')).toBeVisible();
    await expect(
      drawer.locator('a[href="/logs?camera=garage"]').last(),
    ).toBeVisible();
    await expect(
      drawer.locator('a[href="/settings?page=cameraFfmpeg&camera=garage"]'),
    ).toBeVisible();
  });

  test("restarts are listed per camera, newest first", async ({
    frigateApp,
  }) => {
    const now = Math.floor(Date.now() / 1000);
    await gotoHealth(frigateApp, troubledHistory(now));
    await frigateApp.page
      .getByRole("button", { name: "Open Backyard" })
      .click();
    const drawer = frigateApp.page.getByTestId("camera-health-drawer");
    const incidents = drawer.getByTestId("camera-health-incident");
    await expect(incidents).toHaveCount(2);
    await expect(incidents.first()).toContainText("Restart · stalled");
    await expect(incidents.first()).toContainText("ffmpeg watchdog");
    await expect(incidents.last()).toContainText("Restart · connection lost");
  });

  test("a camera with nothing to report says so", async ({ frigateApp }) => {
    await gotoHealth(frigateApp);
    await frigateApp.page
      .getByRole("button", { name: "Open Front Door" })
      .click();
    const drawer = frigateApp.page.getByTestId("camera-health-drawer");
    await expect(
      drawer.getByTestId("camera-health-no-incidents"),
    ).toContainText("No capture incidents were recorded in this window.");
  });

  test("the drawer steps between cameras in the order the table shows", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    await frigateApp.page
      .getByRole("button", { name: "Open Backyard" })
      .click();
    const drawer = frigateApp.page.getByTestId("camera-health-drawer");
    await expect(drawer.getByText("1 of 3")).toBeVisible();

    await drawer.getByRole("button", { name: "Next camera" }).click();
    await expect(drawer.getByText("2 of 3")).toBeVisible();
    await drawer.getByRole("button", { name: "Previous camera" }).click();
    await expect(drawer.getByText("1 of 3")).toBeVisible();

    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(frigateApp.page).not.toHaveURL(/health=/);
  });

  test("software decoding is a note in the drawer and a status bar message for a day (D10, D14)", async ({
    frigateApp,
  }) => {
    await gotoHealth(frigateApp);
    const now = Date.now() / 1000;
    const message = frigateApp.page.getByText(
      "Garage: hardware decoding kept failing, now decoding in software",
    );
    await expect(async () => {
      sendStats(frigateApp, now + 5, {
        garage: { hwaccel_fallback: true, hwaccel_fallback_since: now - 3600 },
      });
      await expect(
        frigateApp.page.getByTestId("camera-health-garage"),
      ).toHaveAttribute("data-state", "ok", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    if (!frigateApp.isMobile) {
      // UI110: the bar lists its warnings behind a chip; the list stays open
      // below, so the message leaving it is what the last check sees
      await openStatusIssues(frigateApp.page);
      await expect(message).toBeVisible();
    }

    await frigateApp.page.getByRole("button", { name: "Open Garage" }).click();
    await expect(
      frigateApp.page.getByTestId("camera-health-note"),
    ).toContainText(
      "Decodes in software because hardware decoding kept failing",
    );
  });

  test(
    "the table and its drawer work on a phone @mobile",
    { tag: "@mobile-only" },
    async ({ frigateApp }) => {
      await gotoHealth(frigateApp);
      await expect(
        frigateApp.page.getByTestId("camera-health-front_door"),
      ).toBeVisible();
      await frigateApp.page
        .getByRole("button", { name: "Open Garage" })
        .click();
      await expect(
        frigateApp.page.getByTestId("camera-health-drawer"),
      ).toBeVisible();
    },
  );
});

test("a shared ?camera= link does not cover the page with the drawer @high @mobile", async ({
  frigateApp,
}) => {
  // `camera` is a System-wide view selection that survives a tab change, so
  // other tabs and shared links carry it onto Health. Opening the modal drawer
  // for it would put a sheet over the page header the moment such a link
  // landed here, which is how UI131 first broke the ingress and clipboard
  // specs: both deep-link to /system?camera=front_door#health and then reach
  // for the header.
  const { page } = frigateApp;
  await frigateApp.goto("/system?camera=front_door#health");
  await expect(page.getByTestId("camera-health-table")).toBeVisible();
  await expect(page.getByTestId("camera-health-drawer")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy link to this view" }),
  ).toBeVisible();
});

test("camera health selection survives reload and browser history @high @mobile", async ({
  frigateApp,
}) => {
  await gotoHealth(frigateApp);
  const { page } = frigateApp;
  await page.getByRole("button", { name: "Open Front Door" }).click();
  await expect(page).toHaveURL(/health=front_door/);
  await expect(page.getByTestId("camera-health-drawer")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("camera-health-drawer")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("camera-health-drawer")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("camera-health-drawer")).toBeVisible();
});

test.describe("Camera health source state (I57) @high", () => {
  test("the drawer says whether go2rtc is connected to each of the camera's streams", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      go2rtcState: {
        cameras: {
          garage: [
            { name: "garage", source: "rtsp://10.0.0.7:554" },
            {
              name: "garage_sub",
              connected: false,
              bytes_received: 0,
              bytes_per_second: 0,
              consumers: 0,
              codecs: [],
              source: "ffmpeg:http://10.0.0.7",
            },
            {
              name: "garage_old",
              configured: false,
              connected: false,
              bytes_per_second: null,
              consumers: 0,
              codecs: [],
              source: null,
            },
          ],
        },
      },
    });
    await gotoHealth(frigateApp);
    await frigateApp.page.getByRole("button", { name: "Open Garage" }).click();
    const section = frigateApp.page
      .getByTestId("camera-health-drawer")
      .getByTestId("source-state");
    await expect(section).toContainText("Source in go2rtc");

    const streams = section.getByTestId("source-state-stream");
    await expect(streams).toHaveCount(3);
    await expect(streams.nth(0)).toHaveAttribute("data-state", "connected");
    await expect(streams.nth(0)).toContainText("Connected");
    await expect(streams.nth(0)).toContainText(
      "rtsp://10.0.0.7:554 · 512 kbit/s · 1 reader · H264, AAC",
    );

    await expect(streams.nth(1)).toHaveAttribute("data-state", "notConnected");
    await expect(streams.nth(1)).toContainText("garage_sub");
    await expect(streams.nth(1)).toContainText("Not connected");
    await expect(streams.nth(1)).toContainText(
      "ffmpeg:http://10.0.0.7 · 0 readers",
    );
    await expect(streams.nth(1)).not.toContainText("bit/s");

    await expect(streams.nth(2)).toHaveAttribute("data-state", "notConfigured");
    await expect(streams.nth(2)).toContainText("Not set up in go2rtc");
    await expect(section.getByTestId("source-state-hint")).toContainText(
      "only while something reads the stream",
    );

    // Stepping to the next camera shows that camera's own stream.
    await frigateApp.page.getByRole("button", { name: "Next camera" }).click();
    await expect(streams).toHaveCount(1);
    await expect(streams).toHaveAttribute("data-state", "connected");
    await expect(section.getByTestId("source-state-hint")).toHaveCount(0);
  });

  test("an unreachable go2rtc is one muted line, not an error @mobile", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({ go2rtcState: { available: false } });
    await gotoHealth(frigateApp);
    await frigateApp.page
      .getByRole("button", { name: "Open Front Door" })
      .click();
    const section = frigateApp.page.getByTestId("source-state");
    await expect(section.getByTestId("source-state-message")).toHaveText(
      "go2rtc is not reachable, so the state of the source is unknown.",
    );
    await expect(section.getByTestId("source-state-stream")).toHaveCount(0);
    // The rest of the drawer is unaffected.
    await expect(
      frigateApp.page.getByTestId("camera-health-metrics"),
    ).toBeVisible();
  });
});

test.describe("Camera health ping (I60) @high", () => {
  test("the drawer tells a camera that is off the network from one that answers", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      go2rtcState: {
        cameras: {
          garage: [{ name: "garage", connected: false, bytes_per_second: 0 }],
        },
        pings: {
          garage: UNREACHABLE_PING,
          front_door: { loss: 1 / 3, method: "tcp" },
        },
      },
    });
    await gotoHealth(frigateApp);
    await frigateApp.page.getByRole("button", { name: "Open Garage" }).click();
    const drawer = frigateApp.page.getByTestId("camera-health-drawer");
    const section = drawer.getByTestId("source-state");
    const ping = section.getByTestId("camera-ping");
    // Reopening from the table keeps this independent of the table's order.
    const reopen = async (name: string) => {
      await drawer.getByRole("button", { name: "Close" }).click();
      await expect(drawer).toHaveCount(0);
      await frigateApp.page.getByRole("button", { name }).click();
    };

    await expect(ping).toHaveAttribute("data-state", "unreachable");
    await expect(ping).toContainText("Network");
    await expect(ping).toContainText("No ping reply");
    await expect(ping).not.toContainText(" ms");
    await expect(section.getByTestId("camera-ping-hint")).toHaveText(
      "The camera is off the network or powered down, so its stream cannot work either.",
    );
    // The stream below it is still listed.
    await expect(section.getByTestId("source-state-stream")).toHaveAttribute(
      "data-state",
      "notConnected",
    );

    // The default camera answers every ping.
    await reopen("Open Backyard");
    await expect(ping).toHaveAttribute("data-state", "reachable");
    await expect(ping).toContainText("Answers ping");
    await expect(ping).toContainText("12.3 ms");
    await expect(ping).not.toContainText("lost");
    await expect(section.getByTestId("camera-ping-hint")).toHaveCount(0);

    await reopen("Open Front Door");
    await expect(ping).toHaveAttribute("data-state", "lossy");
    await expect(ping).toContainText("Answers ping, some lost");
    await expect(ping).toContainText(
      "12.3 ms · 33% lost · checked on the stream port",
    );
  });

  test("a camera that has not been pinged yet shows no network line @mobile", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      go2rtcState: { pings: { front_door: null } },
    });
    await gotoHealth(frigateApp);
    await frigateApp.page
      .getByRole("button", { name: "Open Front Door" })
      .click();
    const section = frigateApp.page.getByTestId("source-state");
    await expect(section.getByTestId("source-state-stream")).toHaveCount(1);
    await expect(section.getByTestId("camera-ping")).toHaveCount(0);
  });
});

test.describe("Saved main recording coverage @high", () => {
  test("healthy capture still reveals fragmented saved footage", async ({
    frigateApp,
  }, testInfo) => {
    const cutoff = Math.floor((Date.now() / 1000 - 120) / 300) * 300;
    await gotoHealth(frigateApp, {
      front_door: {
        recording: {
          status: "gaps",
          coverage_percent: 50,
          analyzed_seconds: 600,
          requested_seconds: 86400,
          missing_seconds: 300,
          gap_count: 0,
          longest_gap_seconds: 0.5,
          mature_before: cutoff,
          latest_analyzed_end: cutoff,
        },
      },
      backyard: {},
      garage: {},
    });
    const front = frigateApp.page.getByTestId("camera-health-front_door");
    await expect(front).toHaveAttribute("data-state", "ok");
    const recording = front.getByTestId("camera-health-recording");
    await expect(recording).toHaveAttribute("data-recording-status", "gaps");
    await expect(recording).toContainText("50%");
    await expect(recording).toContainText("10m checked");
    await expect(recording).toBeInViewport({ ratio: 1 });
    await expect(
      frigateApp.page.getByTestId("camera-health-summary"),
    ).toContainText("1 camera has recording gaps");
    await frigateApp.page.screenshot({
      path: testInfo.outputPath("recording-health-table.png"),
    });
    await front.getByRole("button", { name: "Open Front Door" }).click();
    const details = frigateApp.page.getByTestId(
      "camera-health-recording-details",
    );
    await expect(details).toHaveAttribute("data-recording-status", "gaps");
    await expect(details).toContainText("50%");
    await expect(details).toContainText("Missing footage");
    await expect(details).toContainText("5 minutes");
    await expect(details).toContainText("does not verify playback integrity");
    await details.scrollIntoViewIfNeeded();
    await frigateApp.page.screenshot({
      path: testInfo.outputPath("recording-health-drawer.png"),
    });
  });

  test("missing and intentional gaps do not claim perfect coverage", async ({
    frigateApp,
  }) => {
    const cutoff = Math.floor((Date.now() / 1000 - 120) / 300) * 300;
    await gotoHealth(frigateApp, {
      front_door: {},
      backyard: {
        recording: {
          status: "not_continuous",
          coverage_percent: null,
          analyzed_seconds: 0,
          requested_seconds: 86400,
          missing_seconds: 0,
          gap_count: 0,
          longest_gap_seconds: 0,
          mature_before: cutoff,
          latest_analyzed_end: null,
        },
      },
      garage: {},
    });
    const unavailable = frigateApp.page
      .getByTestId("camera-health-front_door")
      .getByTestId("camera-health-recording");
    await expect(unavailable).toHaveText("Unavailable");
    await expect(unavailable).not.toContainText("100%");
    const intentional = frigateApp.page
      .getByTestId("camera-health-backyard")
      .getByTestId("camera-health-recording");
    await expect(intentional).toHaveText("Not continuous");
    await expect(intentional).not.toContainText("100%");
  });
});
