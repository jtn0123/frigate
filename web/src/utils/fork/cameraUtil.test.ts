import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETECT_TARGET_PX,
  calculateDetectDimensions,
  detectReolinkCamera,
  isReplayCamera,
  maskUri,
  processCameraName,
} from "@/utils/cameraUtil";

afterEach(() => vi.unstubAllGlobals());

describe("processCameraName", () => {
  it("keeps a valid id without a friendly name", () => {
    expect(processCameraName("front_door")).toEqual({
      finalCameraName: "front_door",
      friendlyName: undefined,
    });
  });

  it("normalizes spaces and keeps the typed name as the friendly name", () => {
    expect(processCameraName("Front  Door")).toEqual({
      finalCameraName: "front_door",
      friendlyName: "Front  Door",
    });
  });

  it("hashes names that cannot become an id", () => {
    const result = processCameraName("Café Porch");
    expect(result.friendlyName).toBe("Café Porch");
    expect(result.finalCameraName).toMatch(/^cam_/);
    expect(processCameraName("Café Porch").finalCameraName).toBe(
      result.finalCameraName,
    );
    expect(processCameraName("1234").finalCameraName).toMatch(/^cam_/);
  });
});

describe("detectReolinkCamera", () => {
  it("queries the backend with the credentials and returns its protocol", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true, protocol: "http-flv" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await detectReolinkCamera("10.0.0.5", "admin", "p&ss")).toBe(
      "http-flv",
    );
    const [url, init] = fetchMock.mock.calls[0] ?? ["", undefined];
    const params = new URL(url).searchParams;
    expect(url).toContain("api/reolink/detect?");
    expect(params.get("host")).toBe("10.0.0.5");
    expect(params.get("username")).toBe("admin");
    expect(params.get("password")).toBe("p&ss");
    expect(init).toEqual({ method: "GET" });
  });

  it.each([
    ["an error status", () => new Response("{}", { status: 500 })],
    [
      "an unsuccessful detection",
      () => new Response(JSON.stringify({ success: false, protocol: "rtsp" })),
    ],
    [
      "a missing protocol",
      () => new Response(JSON.stringify({ success: true })),
    ],
    ["invalid json", () => new Response("not json")],
  ])("returns null for %s", async (_name, respond) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond()),
    );
    expect(await detectReolinkCamera("h", "u", "p")).toBeNull();
  });

  it("returns null when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    expect(await detectReolinkCamera("h", "u", "p")).toBeNull();
  });
});

describe("maskUri", () => {
  it("masks rtsp passwords, including ones containing @", () => {
    expect(maskUri("rtsp://admin:p@ss@10.0.0.1:554/stream")).toBe(
      "rtsp://admin:****@10.0.0.1:554/stream",
    );
  });

  it("masks a password query parameter", () => {
    expect(maskUri("http://10.0.0.1/flv?user=admin&password=secret")).toBe(
      "http://10.0.0.1/flv?user=admin&password=****",
    );
  });

  it("returns other uris unchanged", () => {
    expect(maskUri("rtsp://10.0.0.1/stream")).toBe("rtsp://10.0.0.1/stream");
    expect(maskUri("http://10.0.0.1/flv?user=admin")).toBe(
      "http://10.0.0.1/flv?user=admin",
    );
    expect(maskUri("not a uri")).toBe("not a uri");
  });
});

describe("calculateDetectDimensions", () => {
  it("scales the smaller side to the target and keeps the aspect ratio", () => {
    expect(DETECT_TARGET_PX).toBe(720);
    expect(calculateDetectDimensions(1920, 1080)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(calculateDetectDimensions(1080, 1920)).toEqual({
      width: 720,
      height: 1280,
    });
  });

  it("does not upscale and rounds down to even sizes", () => {
    expect(calculateDetectDimensions(641, 481)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it.each([
    [0, 1080],
    [1920, -1],
    [Number.NaN, 1080],
    [1920, Number.POSITIVE_INFINITY],
    [1, 100],
  ])("rejects %d x %d", (width, height) => {
    expect(calculateDetectDimensions(width, height)).toBeNull();
  });
});

describe("isReplayCamera", () => {
  it("matches the replay prefix only at the start", () => {
    expect(isReplayCamera("_replay_front")).toBe(true);
    expect(isReplayCamera("front_replay_")).toBe(false);
  });
});
