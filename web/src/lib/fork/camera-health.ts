import type { CameraConfig } from "@/types/frigateConfig";
import type {
  CameraRestart,
  CameraRestartKind,
  CameraStats,
  FrigateStats,
} from "@/types/stats";

export type CameraHealthState = "ok" | "degraded" | "offline" | "disabled";

export type CameraHealthReason =
  | "noStats"
  | "noFrames"
  | "lowFps"
  | "skippedFrames"
  | "poorConnection"
  | "reconnects"
  | "stalls"
  | "softwareDecoding";

export type CameraHealth = {
  state: CameraHealthState;
  reasons: CameraHealthReason[];
};

/** Below this fraction of the expected fps the camera counts as degraded. */
const LOW_FPS_RATIO = 0.5;

/**
 * Pure classification of one camera from its config and stats entry so the
 * card and the tests agree on what "degraded" means.
 */
export function computeCameraHealth(
  camera: Pick<CameraConfig, "enabled">,
  stats: CameraStats | undefined,
): CameraHealth {
  if (!camera.enabled) {
    return { state: "disabled", reasons: [] };
  }
  if (!stats) {
    return { state: "offline", reasons: ["noStats"] };
  }
  if (!stats.camera_fps) {
    return { state: "offline", reasons: ["noFrames"] };
  }

  const reasons: CameraHealthReason[] = [];
  if (
    stats.expected_fps &&
    stats.camera_fps < stats.expected_fps * LOW_FPS_RATIO
  ) {
    reasons.push("lowFps");
  }
  if (stats.skipped_fps > 0) {
    reasons.push("skippedFrames");
  }
  if (
    stats.connection_quality === "poor" ||
    stats.connection_quality === "unusable"
  ) {
    reasons.push("poorConnection");
  }
  if (stats.reconnects_last_hour > 0) {
    reasons.push("reconnects");
  }
  if (stats.stalls_last_hour > 0) {
    reasons.push("stalls");
  }
  if (stats.hwaccel_fallback) {
    reasons.push("softwareDecoding");
  }

  return { state: reasons.length > 0 ? "degraded" : "ok", reasons };
}

/**
 * Cameras whose detect stream fell back to software decoding because hardware
 * decoding kept crashing it (D10), for the status bar warning.
 */
export function softwareDecodingCameras(
  stats: Pick<FrigateStats, "cameras"> | undefined,
): string[] {
  return Object.entries(stats?.cameras ?? {})
    .filter(([, cam]) => cam.hwaccel_fallback)
    .map(([name]) => name);
}

/**
 * Restart kinds in the last 24 h, most frequent first (D11), for the one-line
 * summary on the card.
 */
export function restartKindCounts(
  stats: CameraStats | undefined,
): Array<[CameraRestartKind, number]> {
  const kinds: CameraRestartKind[] = [
    "hwaccel",
    "connection",
    "stalled",
    "other",
  ];
  return kinds
    .map((kind): [CameraRestartKind, number] => [
      kind,
      stats?.restart_kinds_24h?.[kind] ?? 0,
    ])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
}

/** The last restarts, newest first (the stats list is oldest first). */
export function newestRestarts(
  stats: CameraStats | undefined,
): CameraRestart[] {
  return [...(stats?.recent_restarts ?? [])].reverse();
}

/** Share of total detection fps consumed by this camera, 0..100. */
export function detectorShare(
  stats: FrigateStats | undefined,
  camera: string,
): number | undefined {
  if (!stats?.cameras) return undefined;
  const total = Object.values(stats.cameras).reduce(
    (sum, cam) => sum + (cam.detection_fps || 0),
    0,
  );
  if (total <= 0) return 0;
  return Math.round(
    ((stats.cameras[camera]?.detection_fps || 0) / total) * 100,
  );
}

/** Camera fps series for the sparkline from a list of stats snapshots. */
export function cameraFpsSeries(
  history: FrigateStats[],
  camera: string,
): number[] {
  return history.map((snapshot) => snapshot.cameras[camera]?.camera_fps ?? 0);
}
