/**
 * Fork (UI131): shaping the /fork/camera_history response for the Health tab.
 *
 * Everything user-facing comes back as numbers or keys, never as a sentence,
 * so the view stays responsible for translation.
 */

import type { CameraStats } from "@/types/stats";
import type {
  CameraHealthNote,
  CameraHealthReason,
  CameraHealthState,
} from "@/lib/fork/camera-health";
import type {
  CameraHistoryIncident,
  CameraHistorySeries,
  HistoryRange,
} from "@/types/fork/cameraHistory";

export const HISTORY_RANGES: readonly HistoryRange[] = [
  "1h",
  "6h",
  "24h",
  "7d",
] as const;

export const DEFAULT_HISTORY_RANGE: HistoryRange = "24h";

/** Window length in seconds, matching RANGE_SPEC in the collector. */
export const RANGE_SECONDS: Record<HistoryRange, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
};

export function isHistoryRange(value: string): value is HistoryRange {
  return (HISTORY_RANGES as readonly string[]).includes(value);
}

/** How the sortable columns order rows. */
export type SortKey = "name" | "state" | "rate" | "uptime" | "share";
export type SortDirection = "asc" | "desc";

/** Severity order, so sorting by state puts the worst camera first. */
const STATE_RANK: Record<CameraHealthState, number> = {
  offline: 5,
  unknown: 4,
  degraded: 3,
  starting: 2,
  disabled: 1,
  ok: 0,
};

export type HealthRow = {
  camera: string;
  label: string;
  state: CameraHealthState;
  /** Why the camera is not ok, as keys the view translates. */
  reasons: CameraHealthReason[];
  notes: CameraHealthNote[];
  /** The live stats entry, or undefined when the snapshot is stale. */
  stats: CameraStats | undefined;
  /** Live frame rate, or undefined when stats are stale. */
  fps: number | undefined;
  expectedFps: number | undefined;
  /** Share of detector time, as a percentage, or undefined when unknown. */
  share: number | undefined;
  uptime: number;
  downtime: number;
  issues: IssueSummary;
  series: CameraHistorySeries | undefined;
};

/** Counts behind the "Issues" column, translated by the view. */
export type IssueSummary = {
  offlineSeconds: number;
  outages: number;
  restarts: number;
  stalls: number;
  reconnects: number;
};

export function isOutage(incident: CameraHistoryIncident): boolean {
  return incident.kind === "outage";
}

/**
 * Summarize one camera's window into the counts the Issues column shows.
 *
 * Args:
 *     series: The camera's history, or undefined before it loads.
 *     cameraStats: The live stats entry, for counters the history does not keep.
 *
 * Returns:
 *     Incident counts for this window.
 */
export function summarizeIssues(
  series: CameraHistorySeries | undefined,
  cameraStats: CameraStats | undefined,
): IssueSummary {
  const incidents = series?.incidents ?? [];
  return {
    offlineSeconds: Math.round(series?.downtime ?? 0),
    outages: incidents.filter(isOutage).length,
    restarts: incidents.length - incidents.filter(isOutage).length,
    stalls: cameraStats?.stalls_last_hour ?? 0,
    reconnects: cameraStats?.reconnects_last_hour ?? 0,
  };
}

export function hasIssues(summary: IssueSummary): boolean {
  return (
    summary.offlineSeconds > 0 ||
    summary.outages > 0 ||
    summary.restarts > 0 ||
    summary.stalls > 0 ||
    summary.reconnects > 0
  );
}

/** A camera ran clean when it is healthy now and had nothing in the window. */
export function ranClean(row: HealthRow): boolean {
  return row.state === "ok" && !hasIssues(row.issues);
}

export function needsAttention(row: HealthRow): boolean {
  return row.state !== "ok" && row.state !== "disabled";
}

/**
 * Order rows by one column.
 *
 * Args:
 *     rows: The rows to order; not mutated.
 *     key: Which column to order by.
 *     direction: "asc" puts the worst or smallest first.
 *
 * Returns:
 *     A new, ordered array.
 */
export function sortRows(
  rows: readonly HealthRow[],
  key: SortKey,
  direction: SortDirection,
): HealthRow[] {
  const sign = direction === "asc" ? 1 : -1;
  const value = (row: HealthRow): number | string => {
    switch (key) {
      case "state":
        return -STATE_RANK[row.state];
      case "rate":
        return row.fps ?? -1;
      case "uptime":
        return row.uptime;
      case "share":
        return row.share ?? -1;
      case "name":
        return row.label.toLowerCase();
    }
  };
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const delta =
      typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : Number(left) - Number(right);
    // Ties keep a stable, readable order rather than the fetch order.
    return (delta || a.label.localeCompare(b.label)) * sign;
  });
}

/**
 * Turn the per-cell frame rates into points a sparkline can draw.
 *
 * Cells with no samples are dropped rather than drawn as zero, and the times
 * keep the remaining points in their real position so a gap reads as a gap.
 *
 * Args:
 *     series: The camera's history, or undefined before it loads.
 *     start: Window start in unix seconds.
 *     cellSeconds: Seconds each cell covers.
 *
 * Returns:
 *     Parallel values and times, both empty when nothing was recorded.
 */
export function sparklinePoints(
  series: CameraHistorySeries | undefined,
  start: number,
  cellSeconds: number,
): { values: number[]; times: number[] } {
  const values: number[] = [];
  const times: number[] = [];
  series?.fps.forEach((value, index) => {
    if (value === null) return;
    values.push(value);
    times.push(start + index * cellSeconds);
  });
  return { values, times };
}

/**
 * Evenly spaced labels under the drawer's uptime strip.
 *
 * Args:
 *     start: Window start in unix seconds.
 *     end: Window end in unix seconds.
 *     count: How many ticks to place, including both ends.
 *
 * Returns:
 *     Unix seconds for each tick, oldest first.
 */
export function stripTicks(start: number, end: number, count = 5): number[] {
  if (count < 2 || end <= start) return [start];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + index * step),
  );
}

/** Seconds an incident lasted, or undefined while it is still open. */
export function incidentDuration(
  incident: CameraHistoryIncident,
): number | undefined {
  if (incident.end == null) return undefined;
  return Math.max(0, Math.round(incident.end - incident.start));
}

/**
 * Split an incident kind into the parts the view needs to label it.
 *
 * The collector stores an ffmpeg restart as "restart:<why>", so this returns
 * the family and, for a restart, the reason behind the colon.
 */
export function incidentKind(incident: CameraHistoryIncident): {
  family: "outage" | "restart";
  reason: string;
} {
  const [family, reason] = incident.kind.split(":", 2);
  return {
    family: family === "outage" ? "outage" : "restart",
    reason: reason || "other",
  };
}
