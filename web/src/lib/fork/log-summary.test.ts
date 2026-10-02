import { describe, expect, it } from "vitest";
import type { LogSummaryGroup } from "@/types/fork/logSummary";
import { isSummaryService, mergeLogSummary, topCamera } from "./log-summary";

function group(overrides: Partial<LogSummaryGroup> = {}): LogSummaryGroup {
  return {
    camera: "doorbell",
    service: "frigate",
    hour: 3600,
    level: "warning",
    count: 2,
    first: 3700,
    last: 3800,
    message: "No frames received from doorbell in 20 seconds",
    signature: "No frames received from doorbell in # seconds",
    ...overrides,
  };
}

describe("log summary shaping", () => {
  it("only the frigate and go2rtc logs have a summary", () => {
    expect(isSummaryService("frigate")).toBe(true);
    expect(isSummaryService("go2rtc")).toBe(true);
    expect(isSummaryService("nginx")).toBe(false);
    expect(isSummaryService("websocket")).toBe(false);
  });

  it("adds a message's hours into one row and keeps the worst level", () => {
    const rows = mergeLogSummary(
      [
        group({ count: 5, first: 7300, last: 7900, hour: 7200 }),
        group({ count: 3, level: "error" }),
        group({ count: 1, level: "info", hour: 0, first: 100, last: 200 }),
        group({ service: "go2rtc", count: 99 }),
      ],
      "frigate",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      camera: "doorbell",
      count: 9,
      first: 100,
      last: 7900,
      level: "error",
      message: "No frames received from doorbell in 20 seconds",
    });
  });

  it("keeps cameras and messages apart, sorted by count then recency", () => {
    const rows = mergeLogSummary(
      [
        group({ camera: null, signature: "a", count: 4, last: 10 }),
        group({ camera: "garage", signature: "a", count: 4, last: 20 }),
        group({ camera: "garage", signature: "b", count: 9 }),
      ],
      "frigate",
    );
    expect(rows.map((row) => [row.camera, row.count])).toEqual([
      ["garage", 9],
      ["garage", 4],
      [null, 4],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it("names the camera with the most repeated lines", () => {
    const rows = mergeLogSummary(
      [
        group({ camera: "garage", count: 4 }),
        group({ camera: "doorbell", signature: "a", count: 3 }),
        group({ camera: "doorbell", signature: "b", count: 3 }),
        group({ camera: null, count: 50 }),
      ],
      "frigate",
    );
    expect(topCamera(rows)).toEqual({ camera: "doorbell", count: 6 });
    expect(
      topCamera(mergeLogSummary([group({ camera: null })], "frigate")),
    ).toBeUndefined();
    expect(topCamera([])).toBeUndefined();
  });
});
