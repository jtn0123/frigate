/**
 * When the status bar should call the live stats feed stale (UI68).
 *
 * Frigate publishes `stats` once per `mqtt.stats_interval` seconds (15 or
 * more, default 60), so staleness is measured from when the last message
 * reached the browser, not from the server's `last_updated`, which would
 * also compare the two machines' clocks.
 */

const DEFAULT_STATS_INTERVAL = 60;

/** Seconds without a new stats message before the feed counts as stale. */
export function statsStaleAfter(statsInterval: number | undefined): number {
  const interval =
    statsInterval !== undefined &&
    Number.isFinite(statsInterval) &&
    statsInterval > 0
      ? statsInterval
      : DEFAULT_STATS_INTERVAL;
  // 1.5 intervals, with at least 15 s of slack for the shortest intervals.
  return Math.max(interval * 1.5, interval + 15);
}

/**
 * True when no stats message has arrived within the allowed window.
 * `receivedAt` and `now` are browser times in milliseconds.
 */
export function isStatsStale(
  receivedAt: number | undefined,
  now: number,
  statsInterval: number | undefined,
): boolean {
  if (receivedAt === undefined) {
    return true;
  }
  return (now - receivedAt) / 1000 > statsStaleAfter(statsInterval);
}
