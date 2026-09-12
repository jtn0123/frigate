import { useEffect, useSyncExternalStore } from "react";
import useSWR from "swr";
import {
  fpsSample,
  mergeFpsSamples,
  type FpsSample,
  type FpsSnapshot,
} from "@/lib/fork/camera-health";
import type { FrigateStats } from "@/types/stats";

/**
 * Recent per-camera frame rates for the Camera Health charts.
 *
 * Seeded from Frigate's own `/stats/history` (a point every 15 s, about the
 * last 20 minutes) so a chart has a shape as soon as the page opens, then
 * extended by the live stats messages (one a minute). Module level so the
 * history survives switching System tabs.
 */

// Only the fields the chart reads, to keep the history response small.
const HISTORY_KEYS = "cameras.camera_fps,service.last_updated";

let history: FpsSample[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pushFpsSamples(samples: FpsSample[]) {
  const next = mergeFpsSamples(history, samples);
  if (next === history) return;
  history = next;
  for (const listener of Array.from(listeners)) listener();
}

export function useFpsHistory(stats: FrigateStats | undefined) {
  const { data: serverHistory } = useSWR<FpsSnapshot[]>(
    ["stats/history", { keys: HISTORY_KEYS }],
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (serverHistory) pushFpsSamples(serverHistory.map(fpsSample));
  }, [serverHistory]);

  useEffect(() => {
    if (stats) pushFpsSamples([fpsSample(stats)]);
  }, [stats]);

  return useSyncExternalStore(subscribe, () => history);
}
