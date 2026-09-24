/**
 * Fork (D54): the System page's stats history over a chosen time range.
 *
 * `/stats/history` serves an in-memory ring of 80 samples 15 s apart, about
 * 20 minutes, which is gone after a restart. `/system/metrics/history` reads
 * the samples the backend stores every minute, averaged into as many points
 * as a graph can draw, so the same graphs can show a day or a month.
 */

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import { usePersistence } from "@/hooks/use-persistence";
import { useLiveStatsHistory } from "@/hooks/fork/use-live-stats-history";
import type { FrigateStats } from "@/types/stats";

/** The live in-memory window, then the stored ranges the backend offers. */
export const METRIC_RANGES = [
  "live",
  "1h",
  "6h",
  "12h",
  "24h",
  "7d",
  "30d",
] as const;

export type MetricRange = (typeof METRIC_RANGES)[number];

/** Where the chosen range is remembered, per browser. */
export const METRIC_RANGE_KEY = "system-metrics-range";

/** Only the fields the General tab graphs, to keep the response small. */
const LIVE_KEYS =
  "detectors.inference_speed,detectors.temperature,detectors.cpu,detectors.mem,gpu_usages,npu_usages,processes.cpu,processes.mem,service.last_updated";

/** How often a stored range is re-read; the backend stores a minute sample. */
const STORED_REFRESH = 60000;

export function isMetricRange(value: unknown): value is MetricRange {
  return METRIC_RANGES.includes(value as MetricRange);
}

/** A range the backend served but has nothing stored for yet reads `empty`. */
export function storedStatus(history: StoredHistory | undefined): string {
  if (!history) {
    return "connected";
  }

  return history.status === "connected" && history.samples.length === 0
    ? "empty"
    : history.status;
}

type StoredHistory = {
  /** `disabled` when the config turned the stored history off. */
  status: "connected" | "unavailable" | "disabled";
  range: string;
  /** Seconds each returned sample averages. */
  resolution?: number;
  samples: FrigateStats[];
};

type SystemMetricsHistoryOptions = {
  isActive: boolean;
  lastUpdated: number;
  setLastUpdated: (last: number) => void;
};

export function useSystemMetricsHistory({
  isActive,
  lastUpdated,
  setLastUpdated,
}: SystemMetricsHistoryOptions) {
  const [stored, setRange] = usePersistence<MetricRange>(
    METRIC_RANGE_KEY,
    "live",
  );
  const range: MetricRange = isMetricRange(stored) ? stored : "live";
  const live = range === "live";

  const { data: liveStats, mutate: refreshLive } = useSWR<FrigateStats[]>(
    live ? ["stats/history", { keys: LIVE_KEYS }] : null,
    { revalidateOnFocus: false },
  );

  const { data: storedHistory, mutate: refreshStored } = useSWR<StoredHistory>(
    live ? null : ["system/metrics/history", { range }],
    { revalidateOnFocus: false, refreshInterval: STORED_REFRESH },
  );

  const [liveHistory, setLiveHistory] = useLiveStatsHistory({
    initialStats: liveStats,
    isActive,
    lastUpdated,
    setLastUpdated,
  });

  const statsHistory = useMemo(
    () => (live ? liveHistory : (storedHistory?.samples ?? [])),
    [live, liveHistory, storedHistory],
  );

  // A stored range owns its samples; only the live window is appended to.
  const setStatsHistory = useCallback(
    (history: FrigateStats[]) => {
      if (live) {
        setLiveHistory(history);
      }
    },
    [live, setLiveHistory],
  );

  // Signature of `useRefreshStatsOnActivate`: resolving to nothing leaves
  // the history to SWR, which is what a stored range wants.
  const refresh = useCallback(async () => {
    if (!live) {
      await refreshStored();
      return undefined;
    }

    return refreshLive();
  }, [live, refreshLive, refreshStored]);

  return {
    statsHistory,
    setStatsHistory,
    refresh,
    range,
    setRange,
    resolution: live ? undefined : storedHistory?.resolution,
    status: live ? "connected" : storedStatus(storedHistory),
  } as const;
}
