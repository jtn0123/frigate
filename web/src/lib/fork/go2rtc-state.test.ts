import { describe, expect, it } from "vitest";
import {
  pingLossPercent,
  pingRoundTrip,
  pingStatus,
  receiveRate,
  sourceStatus,
} from "./go2rtc-state";

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

describe("pingStatus", () => {
  it("is reachable only when every ping was answered", () => {
    expect(pingStatus({ reachable: true, loss: 0 })).toBe("reachable");
    expect(pingStatus({ reachable: true, loss: 1 / 3 })).toBe("lossy");
    expect(pingStatus({ reachable: false, loss: 1 })).toBe("unreachable");
  });

  it("lets the answer decide when the loss disagrees with it", () => {
    expect(pingStatus({ reachable: false, loss: 0 })).toBe("unreachable");
    expect(pingStatus({ reachable: true, loss: 1 })).toBe("lossy");
  });
});

describe("pingLossPercent", () => {
  it("rounds the share to a whole percent", () => {
    expect(pingLossPercent(0)).toBe("0");
    expect(pingLossPercent(1 / 3)).toBe("33");
    expect(pingLossPercent(2 / 3)).toBe("67");
    expect(pingLossPercent(1)).toBe("100");
  });

  it("keeps some loss away from 0% and from 100%", () => {
    expect(pingLossPercent(0.001)).toBe("1");
    expect(pingLossPercent(0.999)).toBe("99");
  });

  it("has no loss to show for a share that is not one", () => {
    expect(pingLossPercent(Number.NaN)).toBe("0");
    expect(pingLossPercent(-0.5)).toBe("0");
    expect(pingLossPercent(4)).toBe("100");
  });
});

describe("pingRoundTrip", () => {
  it("has nothing to show without a round trip", () => {
    expect(pingRoundTrip(null)).toBeUndefined();
    expect(pingRoundTrip(undefined)).toBeUndefined();
    expect(pingRoundTrip(Number.NaN)).toBeUndefined();
    expect(pingRoundTrip(-1)).toBeUndefined();
  });

  it("keeps one decimal until the number gets long", () => {
    expect(pingRoundTrip(0)).toBe("0.0");
    expect(pingRoundTrip(0.42)).toBe("0.4");
    expect(pingRoundTrip(12.34)).toBe("12.3");
    // 99.96 would read "100.0"
    expect(pingRoundTrip(99.96)).toBe("100");
    expect(pingRoundTrip(1234.5)).toBe("1235");
  });
});
