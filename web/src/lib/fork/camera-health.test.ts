import { describe, expect, it } from "vitest";
import type { CameraStats, FrigateStats } from "@/types/stats";
import {
  computeCameraHealth,
  connectionQualityProps,
  enabledFromWs,
  newestRestarts,
  restartKindCounts,
  softwareDecodingCameras,
} from "./camera-health";

function cameraStats(overrides: Partial<CameraStats> = {}): CameraStats {
  return {
    audio_dBFPS: 0,
    audio_rms: 0,
    camera_fps: 5,
    capture_pid: 1,
    detection_enabled: 1,
    detection_fps: 5,
    ffmpeg_pid: 2,
    pid: 3,
    process_fps: 5,
    skipped_fps: 0,
    connection_quality: "excellent",
    expected_fps: 5,
    reconnects_last_hour: 0,
    stalls_last_hour: 0,
    ...overrides,
  };
}

describe("connectionQualityProps", () => {
  it("returns indicator props when quality is present", () => {
    expect(connectionQualityProps(cameraStats())).toEqual({
      quality: "excellent",
      expectedFps: 5,
      reconnects: 0,
      stalls: 0,
    });
  });

  it("is undefined when the stats payload omits quality (e2e /api/stats mock)", () => {
    const stats = cameraStats();
    Reflect.deleteProperty(stats, "connection_quality");
    Reflect.deleteProperty(stats, "expected_fps");
    expect(connectionQualityProps(stats)).toBeUndefined();
  });
});

describe("enabledFromWs", () => {
  it("uses the config flag until the WS payload arrives", () => {
    expect(enabledFromWs(undefined, true)).toBe(true);
    expect(enabledFromWs(undefined, false)).toBe(false);
    expect(enabledFromWs("ON", false)).toBe(true);
    expect(enabledFromWs("OFF", true)).toBe(false);
  });
});

describe("computeCameraHealth", () => {
  it("is ok when the stream is healthy", () => {
    expect(computeCameraHealth({ enabled: true }, cameraStats())).toEqual({
      state: "ok",
      reasons: [],
      notes: [],
    });
  });

  it("stays ok through a reconnect, a stall and some skipped frames (D14)", () => {
    const health = computeCameraHealth(
      { enabled: true },
      cameraStats({
        connection_quality: "fair",
        reconnects_last_hour: 2,
        stalls_last_hour: 1,
        process_fps: 4,
        skipped_fps: 1,
      }),
    );
    expect(health).toEqual({ state: "ok", reasons: [], notes: [] });
  });

  it.each([
    ["lowFps", { camera_fps: 2 }],
    ["skippedFrames", { process_fps: 2.5, skipped_fps: 2.5 }],
    ["poorConnection", { connection_quality: "poor", reconnects_last_hour: 3 }],
    ["stalls", { stalls_last_hour: 5 }],
  ] satisfies Array<[string, Partial<CameraStats>]>)(
    "is degraded for %s",
    (reason, overrides) => {
      const health = computeCameraHealth(
        { enabled: true },
        cameraStats(overrides),
      );
      expect(health.state).toBe("degraded");
      expect(health.reasons).toEqual([reason]);
    },
  );

  it("notes software decoding without calling the camera degraded (D14)", () => {
    const health = computeCameraHealth(
      { enabled: true },
      cameraStats({ hwaccel_fallback: true }),
    );
    expect(health).toEqual({
      state: "ok",
      reasons: [],
      notes: ["softwareDecoding"],
    });
  });

  it("treats a missing fallback field (older backend) as hardware decoding", () => {
    const health = computeCameraHealth({ enabled: true }, cameraStats());
    expect(health.notes).not.toContain("softwareDecoding");
  });

  it("says starting instead of offline or degraded right after a start", () => {
    const starting = { state: "starting", reasons: [], notes: [] };
    expect(
      computeCameraHealth(
        { enabled: true },
        cameraStats({ camera_fps: 0 }),
        30,
      ),
    ).toEqual(starting);
    expect(computeCameraHealth({ enabled: true }, undefined, 30)).toEqual(
      starting,
    );
    expect(
      computeCameraHealth(
        { enabled: true },
        cameraStats({ camera_fps: 1 }),
        30,
      ),
    ).toEqual(starting);
    expect(
      computeCameraHealth({ enabled: true }, cameraStats(), 30).state,
    ).toBe("ok");
  });

  it("reports offline once the start-up grace is over", () => {
    const offline = { state: "offline", reasons: ["noFrames"], notes: [] };
    expect(
      computeCameraHealth(
        { enabled: true },
        cameraStats({ camera_fps: 0 }),
        300,
      ),
    ).toEqual(offline);
    expect(
      computeCameraHealth({ enabled: true }, cameraStats({ camera_fps: 0 })),
    ).toEqual(offline);
  });

  it("keeps a disabled camera disabled during start-up", () => {
    expect(computeCameraHealth({ enabled: false }, undefined, 30).state).toBe(
      "disabled",
    );
  });
});

describe("softwareDecodingCameras", () => {
  const now = 1_800_000_000;

  it("lists the cameras that switched in the last day", () => {
    const stats: Pick<FrigateStats, "cameras"> = {
      cameras: {
        dining_room: cameraStats({
          hwaccel_fallback: true,
          hwaccel_fallback_since: now - 3600,
        }),
        c120_2: cameraStats({
          hwaccel_fallback: true,
          hwaccel_fallback_since: now - 3 * 86400,
        }),
        doorbell: cameraStats({ hwaccel_fallback: false }),
        garage: cameraStats(),
      },
    };
    expect(softwareDecodingCameras(stats, now)).toEqual(["dining_room"]);
  });

  it("keeps the warning when the backend does not say when it switched", () => {
    const stats: Pick<FrigateStats, "cameras"> = {
      cameras: {
        garage: cameraStats({
          hwaccel_fallback: true,
          hwaccel_fallback_since: null,
        }),
      },
    };
    expect(softwareDecodingCameras(stats, now)).toEqual(["garage"]);
  });

  it("is empty without stats", () => {
    expect(softwareDecodingCameras(undefined, now)).toEqual([]);
  });
});

describe("restart history (D11)", () => {
  it("orders restart kinds by how often they happened", () => {
    const stats = cameraStats({
      restarts_24h: 6,
      restart_kinds_24h: { connection: 1, hwaccel: 4, other: 1, stalled: 0 },
    });
    expect(restartKindCounts(stats)).toEqual([
      ["hwaccel", 4],
      ["connection", 1],
      ["other", 1],
    ]);
  });

  it("has nothing to show for a camera without restarts or an older backend", () => {
    expect(restartKindCounts(cameraStats())).toEqual([]);
    expect(newestRestarts(cameraStats())).toEqual([]);
    expect(newestRestarts(undefined)).toEqual([]);
  });

  it("lists the latest restart first without mutating the stats", () => {
    const recent = [
      { time: 100, role: "detect", kind: "hwaccel" as const, message: "a" },
      { time: 200, role: "record", kind: "stalled" as const, message: "b" },
    ];
    const stats = cameraStats({ recent_restarts: recent });
    expect(newestRestarts(stats).map((r) => r.time)).toEqual([200, 100]);
    expect(recent.at(0)?.time).toBe(100);
  });
});
