import { describe, expect, it } from "vitest";
import { isMetricRange, storedStatus } from "./use-system-metrics-history";

describe("isMetricRange", () => {
  it("accepts the ranges the toggle offers", () => {
    expect(isMetricRange("live")).toBe(true);
    expect(isMetricRange("30d")).toBe(true);
  });

  it("rejects anything else, including a stale stored value", () => {
    expect(isMetricRange("90d")).toBe(false);
    expect(isMetricRange(undefined)).toBe(false);
  });
});

describe("storedStatus", () => {
  it("is connected while the live window is showing", () => {
    expect(storedStatus(undefined)).toBe("connected");
  });

  it("calls a range the backend has nothing for empty", () => {
    expect(
      storedStatus({ status: "connected", range: "7d", samples: [] }),
    ).toBe("empty");
  });

  it("keeps the backend's own status otherwise", () => {
    expect(storedStatus({ status: "disabled", range: "7d", samples: [] })).toBe(
      "disabled",
    );
    expect(
      storedStatus({
        status: "connected",
        range: "7d",
        samples: [{} as never],
      }),
    ).toBe("connected");
  });
});
