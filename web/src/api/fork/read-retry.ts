import axios from "axios";

/**
 * Fork (C17): how long to wait before retrying a failed SWR read.
 *
 * Reads give up after `errorRetryCount` attempts, but the app shell waits on
 * the profile and config reads before it renders anything, so a page opened
 * while Frigate restarted (502s) stayed on a spinner after the last attempt.
 * Those two keep retrying with a capped backoff while the server errors or is
 * unreachable; a 4xx answer is final.
 */
const SHELL_READ_KEYS = new Set(["/profile", "config"]);
export const SHELL_RETRY_MAX_MS = 30_000;

type RetryConfig = {
  errorRetryCount?: number;
  errorRetryInterval: number;
};

/** Milliseconds until the next attempt, or undefined to stop retrying. */
export function readRetryDelay(
  key: unknown,
  error: unknown,
  retryCount: number,
  config: RetryConfig,
): number | undefined {
  const shell = typeof key === "string" && SHELL_READ_KEYS.has(key);
  if (shell) {
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    if (status !== undefined && status < 500) return undefined;
  } else if (
    config.errorRetryCount !== undefined &&
    retryCount > config.errorRetryCount
  ) {
    return undefined;
  }

  // SWR's own backoff: interval * 2^n (n capped at 8), jittered 0.5x to 1.5x.
  const backoff =
    Math.floor((Math.random() + 0.5) * (1 << Math.min(retryCount, 8))) *
    config.errorRetryInterval;
  return shell ? Math.min(backoff, SHELL_RETRY_MAX_MS) : backoff;
}
