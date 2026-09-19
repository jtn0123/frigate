/**
 * Fork (UI107): the System tabs' stats history, seeded from
 * `stats/history` and extended by the live stats stream.
 *
 * Upstream returned early while the history read was empty, so on a fresh
 * start (the backend has no samples yet) live stats were never appended and
 * the graphs stayed on skeletons. An empty history now grows from live
 * samples, and every history is capped at the backend's window.
 */

import { startTransition, useEffect, useState } from "react";
import { useFrigateStats } from "@/api/ws";
import type { FrigateStats } from "@/types/stats";

/** Samples the backend keeps (`MAX_STATS_POINTS` in frigate/stats/emitter.py). */
export const MAX_STATS_POINTS = 80;

/** Append `sample`, dropping the oldest once the window is full. */
export function appendStatsSample<T>(history: readonly T[], sample: T): T[] {
  return history.length >= MAX_STATS_POINTS
    ? [...history.slice(1), sample]
    : [...history, sample];
}

type LiveStatsHistoryOptions = {
  initialStats: FrigateStats[] | undefined;
  isActive: boolean;
  lastUpdated: number;
  setLastUpdated: (last: number) => void;
};

export function useLiveStatsHistory({
  initialStats,
  isActive,
  lastUpdated,
  setLastUpdated,
}: LiveStatsHistoryOptions) {
  const [statsHistory, setStatsHistory] = useState<FrigateStats[]>([]);
  // undefined until the first stats frame, whatever the hook's type says
  const updatedStats = useFrigateStats() as FrigateStats | undefined;

  useEffect(() => {
    if (initialStats == undefined) {
      return;
    }

    if (statsHistory.length == 0 && initialStats.length > 0) {
      startTransition(() => setStatsHistory(initialStats));
      return;
    }

    if (!isActive || !updatedStats) {
      return;
    }

    if (updatedStats.service.last_updated > lastUpdated) {
      setStatsHistory(appendStatsSample(statsHistory, updatedStats));
      setLastUpdated(updatedStats.service.last_updated);
    }
  }, [
    initialStats,
    updatedStats,
    statsHistory,
    lastUpdated,
    setLastUpdated,
    isActive,
  ]);

  return [statsHistory, setStatsHistory] as const;
}
