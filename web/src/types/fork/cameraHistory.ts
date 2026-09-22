/** Fork (UI131): the /fork/camera_history response behind the Health tab. */

export type HistoryRange = "1h" | "6h" | "24h" | "7d";

/** Worst state a cell saw; "none" means no samples landed in it. */
export type HistoryCellState = "ok" | "degraded" | "offline" | "none";

export type CameraHistoryIncident = {
  /** "outage", or "restart:<why>" for an ffmpeg restart. */
  kind: string;
  start: number;
  /** Null while the incident is still open. */
  end: number | null;
  reason: string;
};

export type CameraHistorySeries = {
  uptime: number;
  downtime: number;
  samples: number;
  expected_fps: number;
  /** Mean frame rate per cell; null for a cell with no samples. */
  fps: (number | null)[];
  states: HistoryCellState[];
  incidents: CameraHistoryIncident[];
};

export type CameraHistoryResponse = {
  range: HistoryRange;
  start: number;
  end: number;
  cell_seconds: number;
  bucket_seconds: number;
  cameras: Record<string, CameraHistorySeries>;
};
