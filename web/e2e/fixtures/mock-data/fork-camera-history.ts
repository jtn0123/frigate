/**
 * Per-camera history for GET /api/fork/camera_history (UI131).
 *
 * The default is a quiet window: every camera recorded at its expected rate
 * and nothing went wrong, so the Health tab only shows trouble when a spec
 * asks for it.
 */

export type HistoryRangeMock = "1h" | "6h" | "24h" | "7d";

export type HistoryCellStateMock = "ok" | "degraded" | "offline" | "none";

export interface CameraHistoryIncidentMock {
  kind: string;
  start: number;
  end: number | null;
  reason: string;
}

export interface CameraHistorySeriesMock {
  uptime: number;
  downtime: number;
  samples: number;
  expected_fps: number;
  fps: (number | null)[];
  states: HistoryCellStateMock[];
  incidents: CameraHistoryIncidentMock[];
}

export interface CameraHistoryMock {
  range: HistoryRangeMock;
  start: number;
  end: number;
  cell_seconds: number;
  bucket_seconds: number;
  cameras: Record<string, CameraHistorySeriesMock>;
}

/** Window length and cell count per range, matching RANGE_SPEC in the backend. */
const RANGE_SPEC: Record<HistoryRangeMock, { window: number; cells: number }> =
  {
    "1h": { window: 3600, cells: 12 },
    "6h": { window: 6 * 3600, cells: 24 },
    "24h": { window: 24 * 3600, cells: 24 },
    "7d": { window: 7 * 24 * 3600, cells: 28 },
  };

const DEFAULT_CAMERAS = ["front_door", "backyard", "garage"];

export function isHistoryRangeMock(
  value: string | null,
): value is HistoryRangeMock {
  return value === "1h" || value === "6h" || value === "24h" || value === "7d";
}

/** A camera that recorded steadily for the whole window. */
export function cameraHistorySeries(
  cells: number,
  overrides: Partial<CameraHistorySeriesMock> = {},
): CameraHistorySeriesMock {
  return {
    uptime: 100,
    downtime: 0,
    samples: cells,
    expected_fps: 5,
    fps: Array.from({ length: cells }, () => 5),
    states: Array.from<HistoryCellStateMock>({ length: cells }).fill("ok"),
    incidents: [],
    ...overrides,
  };
}

export function cameraHistoryFactory(
  range: string | null,
  cameras?: Record<string, Partial<CameraHistorySeriesMock>>,
  now = Math.floor(Date.now() / 1000),
): CameraHistoryMock {
  const key = isHistoryRangeMock(range) ? range : "24h";
  const spec = RANGE_SPEC[key];
  const cellSeconds = Math.round(spec.window / spec.cells);
  const names = Object.keys(cameras ?? {});
  const series: Record<string, CameraHistorySeriesMock> = {};
  for (const name of names.length > 0 ? names : DEFAULT_CAMERAS) {
    series[name] = cameraHistorySeries(spec.cells, cameras?.[name] ?? {});
  }
  return {
    range: key,
    start: now - spec.window,
    end: now,
    cell_seconds: cellSeconds,
    bucket_seconds: 300,
    cameras: series,
  };
}
