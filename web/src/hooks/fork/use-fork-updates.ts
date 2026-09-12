import useSWR from "swr";
import type { ForkUpdateState } from "@/lib/fork/updates";

// The server caches GitHub for hours, so polling it this often is cheap and
// picks up a new release without a reload.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/** Fork update state from GET /api/fork/updates (UI42). */
export function useForkUpdates() {
  return useSWR<ForkUpdateState>("fork/updates", {
    refreshInterval: REFRESH_INTERVAL_MS,
    revalidateOnFocus: false,
  });
}
