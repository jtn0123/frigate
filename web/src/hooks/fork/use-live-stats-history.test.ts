import { describe, expect, it } from "vitest";
import { appendStatsSample, MAX_STATS_POINTS } from "./use-live-stats-history";

// the window logic is the same for any sample; numbers keep it readable
const sample = (n: number) => n;

describe("appendStatsSample", () => {
  it("grows an empty history from live samples", () => {
    expect(appendStatsSample([], sample(1))).toEqual([sample(1)]);
    expect(appendStatsSample([sample(1)], sample(2))).toHaveLength(2);
  });

  it("drops the oldest sample once the backend window is full", () => {
    const full = Array.from({ length: MAX_STATS_POINTS }, (_, i) => sample(i));
    const next = appendStatsSample(full, sample(MAX_STATS_POINTS));
    expect(next).toHaveLength(MAX_STATS_POINTS);
    expect(next[0]).toEqual(sample(1));
    expect(next.at(-1)).toEqual(sample(MAX_STATS_POINTS));
  });
});
