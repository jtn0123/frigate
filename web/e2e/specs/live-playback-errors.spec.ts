import type { Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { test, expect } from "../fixtures/frigate-test";
import { configFactory } from "../fixtures/mock-data/config";

test("live video stops loading and offers Retry when no frame arrives @mobile", async ({
  frigateApp,
}, testInfo) => {
  const page = frigateApp.page;
  const requests: string[] = [];
  await page.route("**/api/go2rtc/streams/*/diagnostics", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      json: { id: "playback-test", status: "decode_error", codecs: ["H265"] },
    });
  });
  await frigateApp.goto("/#front_door");
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "Live video is unavailable" });
  await expect(failure).toBeVisible({ timeout: 15_000 });
  await expect(failure).toContainText("The server encountered decoding errors");
  await expect(failure).toContainText("playback-test");
  expect(requests).toHaveLength(1);
  await page.screenshot({
    path: testInfo.outputPath("live-playback-error.png"),
  });
  await failure.getByRole("button", { name: "Retry live video" }).click();
  await expect(failure).not.toBeVisible();
  await expect(page).toHaveURL(/#front_door/);
  await expect(failure).toBeVisible({ timeout: 15_000 });
});

// Generated test pattern only; no camera footage or network access is needed.
const retryVideo = readFileSync(
  new URL("../fixtures/media/retry-h264.mp4", import.meta.url),
);
const fragmentOffsets: number[] = [];
for (let offset = 0; offset < retryVideo.length;) {
  const size = retryVideo.readUInt32BE(offset);
  if (size < 8 || offset + size > retryVideo.length)
    throw new Error("Invalid test MP4 box");
  if (retryVideo.toString("ascii", offset + 4, offset + 8) === "moof")
    fragmentOffsets.push(offset);
  offset += size;
}
const avcConfig = retryVideo.indexOf("avcC") + 4;
const retryMime = `video/mp4; codecs="avc1.${retryVideo.subarray(avcConfig + 1, avcConfig + 4).toString("hex")}"`;

test("Retry resumes decoded live video and stays playing past the startup deadline @mobile", async ({
  frigateApp,
}) => {
  const page = frigateApp.page;
  let connections = 0;
  const closedConnections = new Set<number>();
  let diagnostics = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: configFactory({
        go2rtc: { streams: { front_door: "rtsp://camera.invalid/live" } },
      }),
    }),
  );
  await page.route("**/api/go2rtc/streams/*/diagnostics", async (route) => {
    diagnostics++;
    await route.fulfill({ json: { id: "retry-check", status: "healthy" } });
  });
  await page.route("**/api/go2rtc/streams/front_door", (route) =>
    route.fulfill({ json: { producers: [], consumers: [] } }),
  );
  await page.routeWebSocket("**/live/mse/api/ws?src=front_door", (socket) => {
    const attempt = ++connections;
    const socketTimers: ReturnType<typeof setTimeout>[] = [];
    socket.onClose(() => {
      closedConnections.add(attempt);
      for (const timer of socketTimers) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    });
    socket.onMessage((raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "mse") return;
      socket.send(JSON.stringify({ type: "mse", value: retryMime }));
      if (attempt === 1) return;
      socket.send(retryVideo.subarray(0, fragmentOffsets[0]));
      fragmentOffsets.forEach((offset, index) => {
        const timer = setTimeout(() => {
          socket.send(
            retryVideo.subarray(
              offset,
              fragmentOffsets[index + 1] ?? retryVideo.length,
            ),
          );
          timers.delete(timer);
        }, index * 1000);
        timers.add(timer);
        socketTimers.push(timer);
      });
    });
  });
  try {
    await frigateApp.goto("/#front_door");
    await expect.poll(() => connections).toBe(1);
    const failure = page
      .getByRole("alert")
      .filter({ hasText: "Live video is unavailable" });
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => closedConnections.size).toBe(1);
    await failure.getByRole("button", { name: "Retry live video" }).click();
    const video = page.locator("video");
    await expect(video).toBeVisible();
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.videoWidth),
      )
      .toBe(64);
    const frame = await presentedFrames(video);
    expect(frame).toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          video.evaluate((element: HTMLVideoElement) => element.currentTime),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(10.5);
    expect(await presentedFrames(video)).toBeGreaterThan(frame);
    await expect(failure).not.toBeVisible();
    expect(connections).toBe(2);
    expect(diagnostics).toBe(1);
    await page.goto("about:blank");
    await expect.poll(() => closedConnections.size).toBe(2);
    expect(connections).toBe(2);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test.describe("live mode fallback", () => {
  // MsePlayer logs the rejected codec before the view falls back
  test.use({
    expectedErrors: [/MSE error|negotiated codecs|Supported codecs/],
  });

  test("a codec the browser rejects falls back to jsmpeg, not the error card @mobile", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    let jsmpegConnections = 0;
    await page.route("**/api/config", (route) =>
      route.fulfill({
        json: configFactory({
          go2rtc: { streams: { front_door: "rtsp://camera.invalid/live" } },
        }),
      }),
    );
    await page.route("**/api/go2rtc/streams/front_door", (route) =>
      route.fulfill({ json: { producers: [], consumers: [] } }),
    );
    await page.routeWebSocket("**/live/mse/api/ws?src=front_door", (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "mse") return;
        socket.send(
          JSON.stringify({ type: "mse", value: 'video/mp4; codecs="bogus"' }),
        );
      });
    });
    await page.routeWebSocket("**/live/jsmpeg/front_door", () => {
      jsmpegConnections++;
    });

    await frigateApp.goto("/#front_door");

    await expect
      .poll(() => jsmpegConnections, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect(
      page.getByRole("alert").filter({ hasText: "Live video is unavailable" }),
    ).not.toBeVisible();
  });
});

async function presentedFrames(video: Locator): Promise<number> {
  return video.evaluate(
    (element: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        element.requestVideoFrameCallback((_now, metadata) =>
          resolve(metadata.presentedFrames),
        );
      }),
  );
}
