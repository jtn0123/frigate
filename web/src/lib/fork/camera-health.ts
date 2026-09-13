import type { CameraConfig } from "@/types/frigateConfig";
import type {
  CameraRestart,
  CameraRestartKind,
  CameraStats,
  FrigateStats,
} from "@/types/stats";

export type CameraHealthState =
  "ok" | "degraded" | "offline" | "disabled" | "starting" | "unknown";

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
    return { state: "unknown", reasons: ["noStats"], notes };
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

/** One point of the frame-rate chart: when, and each camera's fps then. */
export type FpsSample = { time: number; fps: Partial<Record<string, number>> };

/** What a stats message, or a `/stats/history` entry trimmed by `keys`, carries. */
export type FpsSnapshot = {
  service: { last_updated: number };
  cameras: Partial<Record<string, { camera_fps?: number }>>;
};

/** How far back the frame-rate chart looks; Frigate itself keeps ~20 min. */
export const FPS_HISTORY_SECONDS = 30 * 60;

export function fpsSample(snapshot: FpsSnapshot): FpsSample {
  const fps: Partial<Record<string, number>> = {};
  for (const [name, camera] of Object.entries(snapshot.cameras)) {
    if (typeof camera?.camera_fps === "number") fps[name] = camera.camera_fps;
  }
  return { time: snapshot.service.last_updated, fps };
}

/**
 * Adds new samples in time order, skips ones already known (the live stats
 * message repeats one of the history points) and drops what falls out of the
 * window. Returns `existing` itself when nothing changed, so subscribers do
 * not re-render.
 */
export function mergeFpsSamples(
  existing: FpsSample[],
  incoming: FpsSample[],
  windowSeconds = FPS_HISTORY_SECONDS,
): FpsSample[] {
  const known = new Set(existing.map((sample) => sample.time));
  const fresh = incoming.filter(
    (sample) => sample.time > 0 && !known.has(sample.time),
  );
  if (fresh.length === 0) return existing;
  const merged = [...existing, ...fresh].sort((a, b) => a.time - b.time);
  const newest = merged.at(-1)?.time ?? 0;
  return merged.filter((sample) => sample.time >= newest - windowSeconds);
}

/** One camera's frame rate over time; samples without the camera are skipped. */
export function cameraFpsSeries(
  history: FpsSample[],
  camera: string,
): { times: number[]; values: number[] } {
  const times: number[] = [];
  const values: number[] = [];
  for (const sample of history) {
    const value = sample.fps[camera];
    if (value === undefined) continue;
    times.push(sample.time);
    values.push(value);
  }
  return { times, values };
}

/** Whole minutes a series covers (at least 1 once it has two points). */
export function seriesMinutes(times: number[]): number {
  if (times.length < 2) return 0;
  const span = (times.at(-1) ?? 0) - (times.at(0) ?? 0);
  return Math.max(1, Math.round(span / 60));
}
