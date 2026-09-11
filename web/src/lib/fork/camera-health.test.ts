import { describe, expect, it } from "vitest";
import type { CameraStats, FrigateStats } from "@/types/stats";
import { computeCameraHealth, softwareDecodingCameras } from "./camera-health";

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
