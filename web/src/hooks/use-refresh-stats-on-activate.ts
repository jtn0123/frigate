import { useEffect } from "react";
import type { FrigateStats } from "@/types/stats";

/**
 * Re-fetch stats history when a System tab becomes active.
 *
 * The three metrics views share this "refresh on activate" step. The effect
 * intentionally depends only on `isActive` so a live stats stream does not
 * retrigger the history pull.
 */
export function useRefreshStatsOnActivate(
  isActive: boolean,
  statsHistory: FrigateStats[],
  refreshStats: () => Promise<FrigateStats[] | undefined>,
  setStatsHistory: (stats: FrigateStats[]) => void,
) {
  useEffect(() => {
    if (isActive && statsHistory.length > 0) {
      void refreshStats().then((freshStats) => {
        if (freshStats && freshStats.length > 0) {
          setStatsHistory(freshStats);
        }
      });
    }
    // only re-fetch when tab becomes active, not on data changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);
}
