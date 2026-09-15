import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { SHELL_RETRY_MAX_MS, readRetryDelay } from "./read-retry";

const config = { errorRetryCount: 3, errorRetryInterval: 5000 };
// the middle of the jitter range: the delay is exactly interval * 2^n
const NO_JITTER = 0.5;

function httpError(status: number) {
  return new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    statusText: "",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  });
}

const networkError = new AxiosError("Network Error", "ERR_NETWORK");

function delay(key: string, error: unknown, retryCount: number, cfg = config) {
  return readRetryDelay(key, error, retryCount, cfg, NO_JITTER);
}

describe("readRetryDelay", () => {
  it("uses SWR's backoff for the first attempts", () => {
    expect(delay("events", httpError(500), 1)).toBe(10_000);
    expect(delay("config", httpError(502), 1)).toBe(10_000);
  });

  it("spreads reads by key between half and one and a half times the backoff", () => {
    const keys = ["events", "review", "stats", "exports", "recordings"];
    const delays = keys.map((key) =>
      readRetryDelay(key, httpError(500), 1, config),
    );
    for (const value of delays) {
      expect(value).toBeGreaterThanOrEqual(5_000);
      expect(value).toBeLessThan(15_000);
    }
    // the same read always waits the same time; different reads spread out
    expect(readRetryDelay("events", httpError(500), 1, config)).toBe(delays[0]);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("stops other reads after errorRetryCount attempts", () => {
    expect(delay("events", httpError(500), 3)).toBe(40_000);
    expect(delay("events", httpError(500), 4)).toBeUndefined();
    expect(delay("events", networkError, 4)).toBeUndefined();
  });

  it("keeps retrying the profile and config reads while the server is down", () => {
    for (const key of ["/profile", "config"]) {
      expect(delay(key, httpError(502), 4)).toBe(SHELL_RETRY_MAX_MS);
      expect(delay(key, networkError, 50)).toBe(SHELL_RETRY_MAX_MS);
    }
  });

  it("treats a 4xx on the profile and config reads as final", () => {
    expect(delay("/profile", httpError(401), 1)).toBeUndefined();
    expect(delay("config", httpError(403), 1)).toBeUndefined();
  });

  it("leaves the retry count to a hook that sets its own", () => {
    const once = { errorRetryCount: 1, errorRetryInterval: 5000 };
    expect(delay("events", httpError(500), 2, once)).toBeUndefined();
  });
});
