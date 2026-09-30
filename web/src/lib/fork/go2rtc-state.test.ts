import { describe, expect, it } from "vitest";
import { receiveRate, sourceStatus } from "./go2rtc-state";

describe("sourceStatus", () => {
  it("puts a missing stream ahead of its connection", () => {
    expect(sourceStatus({ configured: false, connected: false })).toBe(
      "notConfigured",
    );
    expect(sourceStatus({ configured: false, connected: true })).toBe(
      "notConfigured",
    );
    expect(sourceStatus({ configured: true, connected: true })).toBe(
      "connected",
    );
    expect(sourceStatus({ configured: true, connected: false })).toBe(
      "notConnected",
    );
  });
});

describe("receiveRate", () => {
  it("has nothing to show without a usable sample", () => {
    expect(receiveRate(null)).toBeUndefined();
    expect(receiveRate(undefined)).toBeUndefined();
    expect(receiveRate(Number.NaN)).toBeUndefined();
    expect(receiveRate(-1)).toBeUndefined();
  });

  it("picks the unit that keeps the number short", () => {
    expect(receiveRate(0)).toEqual({ unit: "bit", value: "0" });
    expect(receiveRate(100)).toEqual({ unit: "bit", value: "800" });
    expect(receiveRate(125)).toEqual({ unit: "kbit", value: "1" });
    expect(receiveRate(64_000)).toEqual({ unit: "kbit", value: "512" });
    // 999.6 kbit/s would round to "1000 kbit/s"
    expect(receiveRate(124_950)).toEqual({ unit: "mbit", value: "1.0" });
    expect(receiveRate(512_500)).toEqual({ unit: "mbit", value: "4.1" });
  });
});
