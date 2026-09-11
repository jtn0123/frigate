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
    });
  });

  it("marks a camera degraded while detect decodes in software", () => {
    const health = computeCameraHealth(
      { enabled: true },
      cameraStats({ hwaccel_fallback: true }),
    );
    expect(health.state).toBe("degraded");
    expect(health.reasons).toContain("softwareDecoding");
  });

  it("treats a missing fallback field (older backend) as hardware decoding", () => {
    const health = computeCameraHealth({ enabled: true }, cameraStats());
    expect(health.reasons).not.toContain("softwareDecoding");
  });
});

describe("softwareDecodingCameras", () => {
  it("lists only the cameras that fell back", () => {
    const stats: Pick<FrigateStats, "cameras"> = {
      cameras: {
        dining_room: cameraStats({ hwaccel_fallback: true }),
        doorbell: cameraStats({ hwaccel_fallback: false }),
        garage: cameraStats(),
      },
    };
    expect(softwareDecodingCameras(stats)).toEqual(["dining_room"]);
  });

  it("is empty without stats", () => {
    expect(softwareDecodingCameras(undefined)).toEqual([]);
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
