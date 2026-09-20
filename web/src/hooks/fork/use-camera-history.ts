/** Fork (UI131): the Health tab's window of per-camera history. */

import { useApi } from "@/api/fork/client";
import type { CameraHistoryResponse } from "@/types/fork/cameraHistory";
import type { HistoryRange } from "@/types/fork/cameraHistory";

/** How often the window is refetched; the collector buckets five minutes. */
const REFRESH_MS = 60_000;

export type CameraHistoryResult = {
  data: CameraHistoryResponse | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
};

/**
 * Read one window of camera history.
 *
 * Args:
 *     range: The window to request.
 *
 * Returns:
 *     The response, plus a refresh callback for the retry affordance.
 */
export function useCameraHistory(range: HistoryRange): CameraHistoryResult {
  const request = useApi("/fork/camera_history", {
    params: { range },
    revalidateOnFocus: false,
    refreshInterval: REFRESH_MS,
    keepPreviousData: true,
  });
  // SWR types its error as `any`; the callers only ever pass it on.
  const error: unknown = request.error;

  return {
    // The generated type says the values may be undefined; the endpoint always
    // fills them, and the view treats a missing camera as "no history yet".
    data: request.data as CameraHistoryResponse | undefined,
    error,
    isLoading: request.isLoading,
    refresh: () => void request.mutate(),
  };
}
