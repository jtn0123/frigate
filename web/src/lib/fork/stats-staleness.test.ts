import { describe, expect, it } from "vitest";
import { isStatsStale, statsStaleAfter } from "./stats-staleness";

describe("statsStaleAfter", () => {
  it("allows one and a half intervals", () => {
    expect(statsStaleAfter(60)).toBe(90);
    expect(statsStaleAfter(120)).toBe(180);
    expect(statsStaleAfter(300)).toBe(450);
  });

  it("keeps at least 15 s of slack for the shortest interval", () => {
    expect(statsStaleAfter(15)).toBe(30);
  });

  it("falls back to the default interval when the config is missing", () => {
    expect(statsStaleAfter(undefined)).toBe(90);
    expect(statsStaleAfter(0)).toBe(90);
    expect(statsStaleAfter(Number.NaN)).toBe(90);
  });
});

describe("isStatsStale", () => {
  it("is stale before any message arrives", () => {
    expect(isStatsStale(undefined, 1_000_000, 60)).toBe(true);
  });

  it("measures from the arrival time", () => {
    expect(isStatsStale(1_000_000, 1_000_000 + 89_000, 60)).toBe(false);
    expect(isStatsStale(1_000_000, 1_000_000 + 91_000, 60)).toBe(true);
    expect(isStatsStale(1_000_000, 1_000_000 + 400_000, 300)).toBe(false);
  });
});
