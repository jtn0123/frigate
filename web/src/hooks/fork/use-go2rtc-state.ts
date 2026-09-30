/** Fork (I57): go2rtc's view of each camera's source, for the Health drawer. */

import useSWR from "swr";

import type { Go2rtcStateResponse } from "@/types/fork/go2rtcState";

/** How often the state is refetched; the backend caches it for five seconds. */
const REFRESH_MS = 30_000;

export type Go2rtcStateResult = {
  data: Go2rtcStateResponse | undefined;
  error: unknown;
  isLoading: boolean;
};

/**
 * Read the go2rtc source state of every camera the user may see.
 *
 * Args:
 *     enabled: Whether to fetch and keep polling; false while nothing shows it.
 *
 * Returns:
 *     The response, or the error when the request failed.
 */
export function useGo2rtcState(enabled: boolean): Go2rtcStateResult {
  // Not `useApi`: the path is not in api.gen.ts yet, so the typed client
  // cannot name it. The key is the same axios-relative string it would use.
  const request = useSWR<Go2rtcStateResponse>(
    enabled ? "fork/go2rtc_state" : null,
    {
      revalidateOnFocus: false,
      refreshInterval: REFRESH_MS,
      keepPreviousData: true,
    },
  );
  // SWR types its error as `any`; the callers only ever pass it on.
  const error: unknown = request.error;

  return { data: request.data, error, isLoading: request.isLoading };
}
