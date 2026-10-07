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

/** Coverage of saved main segments during observed continuous recording. */
export type CameraRecordingHistory = {
  status: "ok" | "gaps" | "unknown" | "not_continuous" | "disabled";
  /** Null when there is no eligible observed period to assess. */
  coverage_percent: number | null;
  analyzed_seconds: number;
  requested_seconds: number;
  missing_seconds: number;
  /** Missing intervals lasting at least ten seconds. */
  gap_count: number;
  longest_gap_seconds: number;
  /** Recent, unfinished recordings are excluded up to this epoch cutoff. */
  mature_before: number;
  latest_analyzed_end: number | null;
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
  /** Older servers omit this independently assessed recording history. */
  recording?: CameraRecordingHistory | null;
};

export type CameraHistoryResponse = {
  range: HistoryRange;
  start: number;
  end: number;
  cell_seconds: number;
  bucket_seconds: number;
  cameras: Record<string, CameraHistorySeries>;
};
