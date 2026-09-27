/**
 * WebRTC streaming-technology availability gating.
 *
 * The connectivity probe needs a live go2rtc, so most of this covers the
 * statically-determinable gate: with webrtc candidates explicitly emptied and
 * no ice_servers, the WebRTC option must be disabled in the stream-technology
 * selector (label "Streaming Technology"). The two-way talk tests fake a
 * connected peer so the probe and the player can get past signaling.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/frigate-test";
import { LivePage } from "../pages/live.page";

// the mocked profile is admin, so useUserPersistence keys are namespaced
const STREAMING_KEY = "streaming-settings:admin";

async function writeIdb(page: Page, entries: Record<string, unknown>) {
  await page.evaluate(async (data) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("keyval-store", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("keyval");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction("keyval", "readwrite");
        const store = tx.objectStore("keyval");
        Object.entries(data).forEach(([key, value]) => store.put(value, key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  }, entries);
}

async function readIdb(page: Page, key: string) {
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

// Metadata of a talk-back camera whose playback audio is AAC only, which
// WebRTC cannot carry, while its backchannel takes G.711.
const AAC_TALKBACK_METADATA = {
  producers: [
    {
      medias: [
        "video, recvonly, H264",
        "audio, recvonly, MPEG4-GENERIC",
        "audio, sendonly, PCMA",
      ],
    },
  ],
  consumers: [],
};

/**
 * Makes every RTCPeerConnection report ICE connected once it has an answer, and
 * hands out a silent microphone, so signaling is all the test has to serve.
 */
async function fakeWebRTCMedia(page: Page) {
  await page.addInitScript(() => {
    const Real = window.RTCPeerConnection;
    class ConnectedPeer extends Real {
      private fakeState: RTCIceConnectionState = "new";
      get iceConnectionState() {
        return this.fakeState;
      }
      async setRemoteDescription() {
        this.fakeState = "connected";
        queueMicrotask(() =>
          this.dispatchEvent(new Event("iceconnectionstatechange")),
        );
      }
      async addIceCandidate() {}
    }
    window.RTCPeerConnection = ConnectedPeer;
    navigator.mediaDevices.getUserMedia = async () =>
      new AudioContext().createMediaStreamDestination().stream;
  });
}

test.describe("Two-way talk over WebRTC @critical", () => {
  test("the mic connects over WebRTC when the playback audio is AAC only", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    await fakeWebRTCMedia(page);
    let webrtcSockets = 0;
    await page.routeWebSocket("**/live/webrtc/api/ws**", (socket) => {
      webrtcSockets++;
      socket.onMessage((raw) => {
        if (JSON.parse(raw.toString()).type !== "webrtc/offer") return;
        socket.send(JSON.stringify({ type: "webrtc/answer", value: "v=0" }));
      });
    });
    // Keep the default MSE player quiet so its failure does not change modes.
    await page.routeWebSocket("**/live/mse/api/ws**", () => {});

    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
        },
      },
    });
    await page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({ json: AAC_TALKBACK_METADATA }),
    );

    await frigateApp.goto("/#front_door");

    const mic = page.getByRole("button", { name: "Enable Two Way Talk" });
    await expect(mic).toBeVisible({ timeout: 10_000 });
    await expect(mic).not.toHaveAttribute("aria-disabled", "true");
    // Only the connectivity probe so far.
    expect(webrtcSockets).toBe(1);

    await mic.scrollIntoViewIfNeeded();
    await mic.click();

    // The player switched to WebRTC and opened both its video connection and
    // the microphone backchannel, rather than showing an active mic that
    // sends nothing.
    await expect.poll(() => webrtcSockets).toBeGreaterThanOrEqual(3);
    await expect(
      page.getByRole("button", { name: "Disable Two Way Talk" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("a stock config probes WebRTC and holds the mic until the verdict", async ({
    frigateApp,
  }) => {
    const { page } = frigateApp;
    // Never answer, so the verdict stays pending.
    let probed = false;
    await page.routeWebSocket("**/live/webrtc/api/ws**", () => {
      probed = true;
    });

    // No go2rtc.webrtc section at all: go2rtc adds default candidates, so
    // this must not read as "not configured".
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
        },
      },
    });
    await page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({ json: AAC_TALKBACK_METADATA }),
    );

    await frigateApp.goto("/#front_door");

    const mic = page.getByRole("button", {
      name: /Checking WebRTC availability/,
    });
    await expect(mic).toBeVisible({ timeout: 10_000 });
    await expect(mic).toHaveAttribute("aria-disabled", "true");
    await expect(mic).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => probed).toBe(true);
    await expect(
      page.getByRole("button", { name: /requires WebRTC/ }),
    ).toHaveCount(0);
  });
});

test.describe("WebRTC availability gating @critical @desktop-only", () => {
  test("desktop: WebRTC option is disabled when no candidates or ice_servers", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
          webrtc: { candidates: [], ice_servers: [] },
        },
      },
    });

    // The single-camera view fetches go2rtc stream metadata once restreamed.
    // The default mock returns {} which lacks `producers` and crashes the
    // capability parser, so return a minimal valid metadata payload.
    await frigateApp.page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({
        json: {
          producers: [{ medias: ["video, recvonly, H264"] }],
          consumers: [],
        },
      }),
    );

    await frigateApp.goto("/#front_door");

    const live = new LivePage(frigateApp.page, true);
    await expect(live.backButton).toBeVisible({ timeout: 10_000 });

    // Open the desktop camera-settings dropdown (the FaCog gear is the last
    // button-like trigger in the single-camera header).
    const gearButtons = frigateApp.page.locator("button:has(svg)");
    await gearButtons.last().click();

    const menu = frigateApp.page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 3_000 });

    // Open the "Streaming Technology" select. Anchor on its label, then click
    // the combobox trigger that follows it within the same field container.
    const technologyTrigger = menu
      .locator('div:has(> label[for="streaming-mode"]) [role="combobox"]')
      .first();
    await expect(technologyTrigger).toBeVisible({ timeout: 3_000 });
    await technologyTrigger.click();

    // The Radix select content is portaled to the document body; the WebRTC
    // option must be present and disabled (aria-disabled="true").
    const webrtcOption = frigateApp.page.getByRole("option", {
      name: /WebRTC/,
    });
    await expect(webrtcOption).toBeVisible({ timeout: 3_000 });
    await expect(webrtcOption).toHaveAttribute("aria-disabled", "true");
    await expect(webrtcOption).toContainText("WebRTC is not configured.");

    // Sanity check: a non-gated option (MSE) is enabled, proving the locator
    // distinguishes enabled from disabled options.
    const mseOption = frigateApp.page.getByRole("option", { name: /MSE/ });
    await expect(mseOption).not.toHaveAttribute("aria-disabled", "true");
  });

  test("desktop: the WebRTC option reports the pending connectivity check", async ({
    frigateApp,
  }) => {
    // Hold the signaling socket open so the probe stays pending. Left alone it
    // fails fast against the preview server and resolves to unreachable, which
    // is the state the first test already covers.
    await frigateApp.page.routeWebSocket("**/live/webrtc/api/ws**", () => {
      // never answer the offer
    });

    // Candidates configured, so the gate reaches the probe rather than
    // stopping at not-configured.
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
          webrtc: { candidates: ["192.168.1.10:8555"], ice_servers: [] },
        },
      },
    });

    await frigateApp.page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({
        json: {
          producers: [{ medias: ["video, recvonly, H264"] }],
          consumers: [],
        },
      }),
    );

    await frigateApp.goto("/#front_door");

    const live = new LivePage(frigateApp.page, true);
    await expect(live.backButton).toBeVisible({ timeout: 10_000 });

    const gearButtons = frigateApp.page.locator("button:has(svg)");
    await gearButtons.last().click();

    const menu = frigateApp.page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 3_000 });

    const technologyTrigger = menu
      .locator('div:has(> label[for="streaming-mode"]) [role="combobox"]')
      .first();
    await expect(technologyTrigger).toBeVisible({ timeout: 3_000 });
    await technologyTrigger.click();

    // Unselectable while the probe runs, but with the reason stated rather
    // than a bare greyed-out row.
    const webrtcOption = frigateApp.page.getByRole("option", {
      name: /WebRTC/,
    });
    await expect(webrtcOption).toBeVisible({ timeout: 3_000 });
    await expect(webrtcOption).toHaveAttribute("aria-disabled", "true");
    await expect(webrtcOption).toContainText(/Checking WebRTC availability/i);
  });

  test("desktop: JSMpeg is no longer offered in the technology selector", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
          webrtc: { candidates: [], ice_servers: [] },
        },
      },
    });

    await frigateApp.page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({
        json: {
          producers: [{ medias: ["video, recvonly, H264"] }],
          consumers: [],
        },
      }),
    );

    await frigateApp.goto("/#front_door");

    const live = new LivePage(frigateApp.page, true);
    await expect(live.backButton).toBeVisible({ timeout: 10_000 });

    const gearButtons = frigateApp.page.locator("button:has(svg)");
    await gearButtons.last().click();

    const menu = frigateApp.page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 3_000 });

    // Technology selector offers MSE/WebRTC but NOT JSMpeg (replaced by the
    // "Force low-bandwidth mode" switch).
    const technologyTrigger = menu
      .locator('div:has(> label[for="streaming-mode"]) [role="combobox"]')
      .first();
    await expect(technologyTrigger).toBeVisible({ timeout: 3_000 });
    await technologyTrigger.click();
    await expect(
      frigateApp.page.getByRole("option", { name: /MSE/ }),
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      frigateApp.page.getByRole("option", { name: /JSMpeg/ }),
    ).toHaveCount(0);
  });

  test("desktop: force low-bandwidth switch disables the technology and stream selectors", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
          webrtc: { candidates: [], ice_servers: [] },
        },
      },
    });

    await frigateApp.page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({
        json: {
          producers: [{ medias: ["video, recvonly, H264"] }],
          consumers: [],
        },
      }),
    );

    await frigateApp.goto("/#front_door");

    const live = new LivePage(frigateApp.page, true);
    await expect(live.backButton).toBeVisible({ timeout: 10_000 });

    const gearButtons = frigateApp.page.locator("button:has(svg)");
    await gearButtons.last().click();

    const menu = frigateApp.page
      .locator('[role="menu"], [data-radix-menu-content]')
      .first();
    await expect(menu).toBeVisible({ timeout: 3_000 });

    // Both selectors are present and enabled to begin with (the switch is off).
    await expect(menu.locator('label[for="streaming-mode"]')).toHaveCount(1);
    const technologyTrigger = menu
      .locator('div:has(> label[for="streaming-mode"]) [role="combobox"]')
      .first();
    const streamTrigger = menu
      .locator('div:has(> label[for="streaming-method"]) [role="combobox"]')
      .first();
    await expect(technologyTrigger).toBeVisible({ timeout: 3_000 });
    await expect(technologyTrigger).toBeEnabled();
    await expect(streamTrigger).toBeVisible({ timeout: 3_000 });
    await expect(streamTrigger).toBeEnabled();

    // Enabling the switch keeps both selectors visible but disables them (the
    // low-bandwidth feed ignores the chosen stream and technology).
    const lowBandwidthSwitch = menu.getByRole("switch", {
      name: "Force low-bandwidth mode",
    });
    await expect(lowBandwidthSwitch).toBeVisible({ timeout: 3_000 });
    await lowBandwidthSwitch.click();

    await expect(menu.locator('label[for="streaming-mode"]')).toHaveCount(1);
    await expect(technologyTrigger).toBeDisabled();
    await expect(streamTrigger).toBeDisabled();

    // Toggling it back off re-enables both.
    await lowBandwidthSwitch.click();
    await expect(technologyTrigger).toBeEnabled();
    await expect(streamTrigger).toBeEnabled();
  });

  test("desktop: saving group streaming settings keeps an unavailable WebRTC choice", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
          webrtc: { candidates: [], ice_servers: [] },
        },
      },
    });

    await frigateApp.page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({
        json: {
          producers: [{ medias: ["video, recvonly, H264"] }],
          consumers: [],
        },
      }),
    );

    const saved = {
      streamName: "front_door",
      streamType: "smart",
      playerMode: "webrtc",
      compatibilityMode: false,
      playAudio: false,
      volume: 1,
    };

    await frigateApp.goto("/");
    await writeIdb(frigateApp.page, {
      [STREAMING_KEY]: { outdoor: { front_door: saved } },
    });
    await frigateApp.goto("/?group=outdoor");

    // With no candidates the dialog resolves WebRTC to MSE for display, but
    // saving must not persist that fallback over the user's choice.
    const live = new LivePage(frigateApp.page, true);
    const menu = await live.openContextMenuOn("front_door");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await menu.getByText("Streaming Settings").click();

    const dialog = frigateApp.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(() => readIdb(frigateApp.page, STREAMING_KEY))
      .toMatchObject({ outdoor: { front_door: { playerMode: "webrtc" } } });
  });
});

test.describe("WebRTC availability gating @critical @mobile-only", () => {
  test("mobile: WebRTC option is disabled when no candidates or ice_servers", async ({
    frigateApp,
  }) => {
    await frigateApp.installDefaults({
      config: {
        go2rtc: {
          streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
          webrtc: { candidates: [], ice_servers: [] },
        },
      },
    });

    await frigateApp.page.route("**/api/go2rtc/streams/front_door**", (route) =>
      route.fulfill({
        json: {
          producers: [{ medias: ["video, recvonly, H264"] }],
          consumers: [],
        },
      }),
    );

    await frigateApp.goto("/#front_door");

    const settingsTrigger = frigateApp.page
      .getByRole("button", {
        name: "Front Door Settings",
        exact: true,
      })
      .and(frigateApp.page.locator('button[aria-haspopup="dialog"]'));
    await settingsTrigger.scrollIntoViewIfNeeded();
    await settingsTrigger.click();

    // The drawer renders a "Streaming Technology" label above its select.
    // Anchor on that label, then open the combobox in the same field block.
    await expect(
      frigateApp.page.getByText("Streaming Technology", { exact: true }),
    ).toBeVisible({ timeout: 3_000 });
    const technologyTrigger = frigateApp.page
      .locator(
        'div:has(> div:text-is("Streaming Technology")) [role="combobox"]',
      )
      .first();
    await expect(technologyTrigger).toBeVisible({ timeout: 3_000 });
    await technologyTrigger.click();

    const webrtcOption = frigateApp.page.getByRole("option", {
      name: /WebRTC/,
    });
    await expect(webrtcOption).toBeVisible({ timeout: 3_000 });
    await expect(webrtcOption).toHaveAttribute("aria-disabled", "true");

    const mseOption = frigateApp.page.getByRole("option", { name: /MSE/ });
    await expect(mseOption).not.toHaveAttribute("aria-disabled", "true");
  });
});
