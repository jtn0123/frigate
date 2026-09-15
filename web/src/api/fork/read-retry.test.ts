import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_RETRY_MAX_MS, readRetryDelay } from "./read-retry";

const config = { errorRetryCount: 3, errorRetryInterval: 5000 };

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

describe("readRetryDelay", () => {
  beforeEach(() => {
    // no jitter: the delay is exactly interval * 2^n
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses SWR's backoff for the first attempts", () => {
    expect(readRetryDelay("events", httpError(500), 1, config)).toBe(10_000);
    expect(readRetryDelay("config", httpError(502), 1, config)).toBe(10_000);
  });

  it("stops other reads after errorRetryCount attempts", () => {
    expect(readRetryDelay("events", httpError(500), 3, config)).toBe(40_000);
    expect(readRetryDelay("events", httpError(500), 4, config)).toBeUndefined();
    expect(readRetryDelay("events", networkError, 4, config)).toBeUndefined();
  });

  it("keeps retrying the profile and config reads while the server is down", () => {
    for (const key of ["/profile", "config"]) {
      expect(readRetryDelay(key, httpError(502), 4, config)).toBe(
        SHELL_RETRY_MAX_MS,
      );
      expect(readRetryDelay(key, networkError, 50, config)).toBe(
        SHELL_RETRY_MAX_MS,
      );
    }
  });

  it("treats a 4xx on the profile and config reads as final", () => {
    expect(
      readRetryDelay("/profile", httpError(401), 1, config),
    ).toBeUndefined();
    expect(readRetryDelay("config", httpError(403), 1, config)).toBeUndefined();
  });

  it("leaves the retry count to a hook that sets its own", () => {
    const once = { errorRetryCount: 1, errorRetryInterval: 5000 };
    expect(readRetryDelay("events", httpError(500), 2, once)).toBeUndefined();
  });
});
