import type { CameraConfig } from "@/types/frigateConfig";
import type {
  CameraRestart,
  CameraRestartKind,
  CameraStats,
  FrigateStats,
} from "@/types/stats";

export type CameraHealthState =
  "ok" | "degraded" | "offline" | "disabled" | "starting";

/** Why a camera is degraded or offline: it is losing frames or detections. */
export type CameraHealthReason =
  | "noStats"
  | "noFrames"
  | "lowFps"
  | "skippedFrames"
  | "poorConnection"
  | "stalls";

/** Worth knowing, but the camera still delivers its frames (D14). */
export type CameraHealthNote = "softwareDecoding";

export type CameraHealth = {
  state: CameraHealthState;
  reasons: CameraHealthReason[];
  notes: CameraHealthNote[];
};

/** Below this fraction of the expected fps the camera counts as degraded. */
const LOW_FPS_RATIO = 0.5;
/** Skipping this share of the frames or more leaves detection too few. */
const SKIPPED_RATIO = 0.5;
/**
 * Stalls in the last hour that make a pattern rather than a blip; Frigate's
 * connection quality stays "excellent" below this.
 */
const STALLS_PER_HOUR = 5;
/**
 * Right after a start, streams connect and frame rates ramp up; Frigate's own
 * status bar also waits this long before it looks for problems.
 */
export const STARTUP_GRACE_SECONDS = 120;
/** How long the status bar mentions a camera's switch to software decoding. */
export const SOFTWARE_DECODING_NOTICE_SECONDS = 24 * 3600;

/**
 * Pure classification of one camera from its config and stats entry so the
 * card and the tests agree on what "degraded" means. A single reconnect,
 * stall or skipped frame is normal and only shows in the numbers; a camera is
 * degraded while it is losing frames or detections (D14).
 */
export function computeCameraHealth(
  camera: Pick<CameraConfig, "enabled">,
  stats: CameraStats | undefined,
  uptime?: number,
): CameraHealth {
  if (!camera.enabled) {
    return { state: "disabled", reasons: [], notes: [] };
  }

  const notes: CameraHealthNote[] = stats?.hwaccel_fallback
    ? ["softwareDecoding"]
    : [];
  const health = classifyStream(stats, notes);
  if (
    health.state !== "ok" &&
    uptime !== undefined &&
    uptime < STARTUP_GRACE_SECONDS
  ) {
    return { state: "starting", reasons: [], notes };
  }
  return health;
}

function classifyStream(
  stats: CameraStats | undefined,
  notes: CameraHealthNote[],
): CameraHealth {
  if (!stats) {
    return { state: "offline", reasons: ["noStats"], notes };
  }
  if (!stats.camera_fps) {
    return { state: "offline", reasons: ["noFrames"], notes };
  }

  const reasons: CameraHealthReason[] = [];
  if (
    stats.expected_fps &&
    stats.camera_fps < stats.expected_fps * LOW_FPS_RATIO
  ) {
    reasons.push("lowFps");
  }
  if (stats.skipped_fps >= stats.camera_fps * SKIPPED_RATIO) {
    reasons.push("skippedFrames");
  }
  if (
    stats.connection_quality === "poor" ||
    stats.connection_quality === "unusable"
  ) {
    reasons.push("poorConnection");
  }
  if (stats.stalls_last_hour >= STALLS_PER_HOUR) {
    reasons.push("stalls");
  }

  return { state: reasons.length > 0 ? "degraded" : "ok", reasons, notes };
}

/**
 * Cameras that switched to software decoding in the last day (D10, D14), for
 * the status bar warning. The switch survives restarts, so without the time
 * limit the warning would stay up for days; the card keeps a note meanwhile.
 * A backend that does not say when it switched keeps the warning.
 */
export function softwareDecodingCameras(
  stats: Pick<FrigateStats, "cameras"> | undefined,
  now: number,
): string[] {
  return Object.entries(stats?.cameras ?? {})
    .filter(
      ([, cam]) =>
        cam.hwaccel_fallback &&
        (!cam.hwaccel_fallback_since ||
          now - cam.hwaccel_fallback_since < SOFTWARE_DECODING_NOTICE_SECONDS),
    )
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

export type ConnectionQuality = CameraStats["connection_quality"];

export type ConnectionQualityProps = {
  quality: ConnectionQuality;
  expectedFps: number;
  reconnects: number;
  stalls: number;
};

function asConnectionQuality(value: unknown): ConnectionQuality | undefined {
  switch (value) {
    case "excellent":
    case "fair":
    case "poor":
    case "unusable":
      return value;
    default:
      return undefined;
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Props for ConnectionQualityIndicator, or undefined when the stats payload
 * omits quality (the /api/stats mock and older backends do). Rendering the
 * indicator anyway calls toFixed on a missing expected_fps.
 */
export function connectionQualityProps(
  stats: CameraStats | undefined,
): ConnectionQualityProps | undefined {
  if (stats === undefined) return undefined;
  const quality = asConnectionQuality(stats.connection_quality);
  if (quality === undefined) return undefined;
  return {
    quality,
    expectedFps: finiteNumber(stats.expected_fps),
    reconnects: finiteNumber(stats.reconnects_last_hour),
    stalls: finiteNumber(stats.stalls_last_hour),
  };
}

/** WS payload is "ON"/"OFF" once it arrives; until then use the config flag. */
export function enabledFromWs(payload: unknown, configured: boolean): boolean {
  if (payload === "ON") return true;
  if (payload === "OFF") return false;
  return configured;
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
