/** Fork (I58): repeated log lines collapsed per camera, for the Logs page. */

import useSWR from "swr";
import type { LogSummaryResponse } from "@/types/fork/logSummary";

/** The endpoint caches for 30 seconds, so asking more often gains nothing. */
const REFRESH_MS = 60_000;

export const LOG_SUMMARY_HOURS = 24;

export type LogSummaryResult = {
  data: LogSummaryResponse | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
};

/**
 * Read the summary of repeated warning and error log lines.
 *
 * The path is not in the generated API types yet, so this uses the plain SWR
 * key the app's fetcher understands instead of the typed `useApi`.
 *
 * Args:
 *     enabled: False skips the request (flag off, or a log without one).
 *     camera: Only count lines attributed to this camera; empty for all.
 *
 * Returns:
 *     The response, plus a refresh callback for the retry affordance.
 */
export function useLogSummary(
  enabled: boolean,
  camera: string = "",
): LogSummaryResult {
  const params = camera
    ? { hours: LOG_SUMMARY_HOURS, camera }
    : { hours: LOG_SUMMARY_HOURS };
  const request = useSWR<LogSummaryResponse>(
    enabled ? ["fork/log_summary", params] : null,
    {
      revalidateOnFocus: false,
      refreshInterval: REFRESH_MS,
      keepPreviousData: true,
    },
  );
  // SWR types its error as `any`; the callers only ever pass it on.
  const error: unknown = request.error;

  return {
    data: request.data,
    error,
    isLoading: request.isLoading,
    refresh: () => void request.mutate(),
  };
}
