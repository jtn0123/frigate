import { useEffect, useSyncExternalStore } from "react";
import type { FrigateStats } from "@/types/stats";

/**
 * Ring buffer of recent stats snapshots keyed by `service.last_updated`.
 *
 * Module level so the sparklines keep their history while the user switches
 * System tabs; fed by whichever component is currently observing stats.
 */
export const STATS_HISTORY_MAX = 60;

let history: FrigateStats[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pushStatsSnapshot(stats: FrigateStats | undefined) {
  if (!stats?.service?.last_updated) return;
  const last = history[history.length - 1];
  if (last && last.service.last_updated >= stats.service.last_updated) {
    return;
  }
  history = [...history, stats].slice(-STATS_HISTORY_MAX);
  for (const listener of Array.from(listeners)) listener();
}

export function useStatsHistory(stats: FrigateStats | undefined) {
  useEffect(() => {
    pushStatsSnapshot(stats);
  }, [stats]);
  return useSyncExternalStore(subscribe, () => history);
}
