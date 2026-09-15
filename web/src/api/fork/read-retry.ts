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

/**
 * An offset from 0 to 1 that spreads retries of different reads apart. It is
 * derived from the key rather than random: the same read always waits the
 * same time, and reads that failed together retry at different times.
 */
export function keyJitter(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + (key.codePointAt(index) ?? 0)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

/** Milliseconds until the next attempt, or undefined to stop retrying. */
export function readRetryDelay(
  key: string,
  error: unknown,
  retryCount: number,
  config: RetryConfig,
  jitter: number = keyJitter(key),
): number | undefined {
  const shell = SHELL_READ_KEYS.has(key);
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

  // SWR's own backoff: interval * 2^n (n capped at 8), spread 0.5x to 1.5x.
  const backoff =
    Math.floor((jitter + 0.5) * (1 << Math.min(retryCount, 8))) *
    config.errorRetryInterval;
  return shell ? Math.min(backoff, SHELL_RETRY_MAX_MS) : backoff;
}
