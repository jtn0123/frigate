/** Fork (I58): shape the log summary for the Logs page's panel. */

import type {
  LogSummaryGroup,
  LogSummaryLevel,
  LogSummaryRow,
  LogSummaryService,
} from "@/types/fork/logSummary";

const LEVEL_RANK: Record<LogSummaryLevel, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** The services that have a summary; nginx and the websocket feed do not. */
export function isSummaryService(
  service: string,
): service is LogSummaryService {
  return service === "frigate" || service === "go2rtc";
}

/**
 * Add up one service's hourly groups into one row per camera and message.
 *
 * The endpoint groups per hour, which is right for a timeline but would list
 * a camera that failed all day twenty-four times.
 *
 * Args:
 *     groups: The response's groups, whatever the service.
 *     service: The log tab being shown.
 *
 * Returns:
 *     Rows sorted by count, highest first.
 */
export function mergeLogSummary(
  groups: LogSummaryGroup[],
  service: LogSummaryService,
): LogSummaryRow[] {
  const rows = new Map<string, LogSummaryRow>();
  for (const group of groups) {
    if (group.service !== service) continue;
    const key = `${group.camera ?? ""}\u0000${group.signature}`;
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        key,
        camera: group.camera,
        level: group.level,
        count: group.count,
        first: group.first,
        last: group.last,
        message: group.message,
      });
      continue;
    }
    row.count += group.count;
    row.first = Math.min(row.first, group.first);
    row.last = Math.max(row.last, group.last);
    if (LEVEL_RANK[group.level] > LEVEL_RANK[row.level]) {
      row.level = group.level;
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.count - a.count || b.last - a.last,
  );
}

/**
 * Find the camera with the most repeated lines.
 *
 * Args:
 *     rows: Merged rows of one service.
 *
 * Returns:
 *     The camera and its count, or undefined when no row names a camera.
 */
export function topCamera(
  rows: LogSummaryRow[],
): { camera: string; count: number } | undefined {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.camera) {
      totals.set(row.camera, (totals.get(row.camera) ?? 0) + row.count);
    }
  }
  let top: { camera: string; count: number } | undefined;
  for (const [camera, count] of totals) {
    if (!top || count > top.count) top = { camera, count };
  }
  return top;
}
