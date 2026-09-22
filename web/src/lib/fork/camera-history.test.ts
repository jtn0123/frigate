import { describe, expect, it } from "vitest";
import type { CameraStats } from "@/types/stats";
import type {
  CameraHistoryIncident,
  CameraHistorySeries,
} from "@/types/fork/cameraHistory";
import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  RANGE_SECONDS,
  hasIssues,
  incidentDuration,
  incidentKind,
  isHistoryRange,
  isOutage,
  needsAttention,
  ranClean,
  sortRows,
  sparklinePoints,
  stripTicks,
  summarizeIssues,
  type HealthRow,
} from "./camera-history";

function series(
  overrides: Partial<CameraHistorySeries> = {},
): CameraHistorySeries {
  return {
    uptime: 100,
    downtime: 0,
    samples: 4,
    expected_fps: 5,
    fps: [5, 5, 5, 5],
    states: ["ok", "ok", "ok", "ok"],
    incidents: [],
    ...overrides,
  };
}

function incident(
  overrides: Partial<CameraHistoryIncident> = {},
): CameraHistoryIncident {
  return { kind: "outage", start: 1000, end: 1600, reason: "", ...overrides };
}

function row(overrides: Partial<HealthRow> = {}): HealthRow {
  return {
    camera: "front_door",
    label: "Front Door",
    state: "ok",
    reasons: [],
    notes: [],
    stats: undefined,
    fps: 5,
    expectedFps: 5,
    share: 50,
    uptime: 100,
    downtime: 0,
    issues: {
      offlineSeconds: 0,
      outages: 0,
      restarts: 0,
      stalls: 0,
      reconnects: 0,
    },
    series: undefined,
    ...overrides,
  };
}

describe("range helpers", () => {
  it("accepts only the ranges the collector keeps", () => {
    expect(HISTORY_RANGES.every(isHistoryRange)).toBe(true);
    expect(isHistoryRange("30m")).toBe(false);
    expect(isHistoryRange("")).toBe(false);
  });

  it("defaults to a day, and each range is longer than the last", () => {
    expect(isHistoryRange(DEFAULT_HISTORY_RANGE)).toBe(true);
    const lengths = HISTORY_RANGES.map((range) => RANGE_SECONDS[range]);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });
});

describe("issue counts behind the Issues column", () => {
  it("counts outages and restarts apart, and reads the rest from stats", () => {
    const stats = {
      stalls_last_hour: 21,
      reconnects_last_hour: 6,
    } as CameraStats;
    const summary = summarizeIssues(
      series({
        downtime: 840.4,
        incidents: [
          incident(),
          incident({ kind: "restart:stalled" }),
          incident({ kind: "restart:connection" }),
        ],
      }),
      stats,
    );
    expect(summary).toEqual({
      offlineSeconds: 840,
      outages: 1,
      restarts: 2,
      stalls: 21,
      reconnects: 6,
    });
    expect(hasIssues(summary)).toBe(true);
  });

  it("is empty when there is neither history nor stats", () => {
    const summary = summarizeIssues(undefined, undefined);
    expect(summary).toEqual({
      offlineSeconds: 0,
      outages: 0,
      restarts: 0,
      stalls: 0,
      reconnects: 0,
    });
    expect(hasIssues(summary)).toBe(false);
  });

  it("tells an outage from a restart", () => {
    expect(isOutage(incident())).toBe(true);
    expect(isOutage(incident({ kind: "restart:hwaccel" }))).toBe(false);
  });
});

describe("which rows the scopes show", () => {
  it("counts a camera clean only when it is ok and had no incidents", () => {
    expect(ranClean(row())).toBe(true);
    expect(ranClean(row({ state: "degraded" }))).toBe(false);
    expect(
      ranClean(
        row({
          issues: {
            offlineSeconds: 0,
            outages: 0,
            restarts: 1,
            stalls: 0,
            reconnects: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("leaves a disabled camera out of the attention scope", () => {
    expect(needsAttention(row({ state: "offline" }))).toBe(true);
    expect(needsAttention(row({ state: "unknown" }))).toBe(true);
    expect(needsAttention(row({ state: "disabled" }))).toBe(false);
    expect(needsAttention(row())).toBe(false);
  });
});

describe("sorting the table", () => {
  const rows = [
    row({
      camera: "b",
      label: "Backyard",
      state: "degraded",
      fps: 3.4,
      uptime: 99.2,
      share: 50,
    }),
    row({
      camera: "g",
      label: "Garage",
      state: "offline",
      fps: 0,
      uptime: 99,
      share: 0,
    }),
    row({
      camera: "f",
      label: "Front Door",
      state: "ok",
      fps: 5,
      uptime: 100,
      share: 50,
    }),
  ];
  const labels = (key: Parameters<typeof sortRows>[1], dir: "asc" | "desc") =>
    sortRows(rows, key, dir).map((entry) => entry.label);

  it("puts the worst camera first when sorting by state", () => {
    expect(labels("state", "asc")).toEqual([
      "Garage",
      "Backyard",
      "Front Door",
    ]);
    expect(labels("state", "desc")).toEqual([
      "Front Door",
      "Backyard",
      "Garage",
    ]);
  });

  it("orders by name, rate and uptime", () => {
    expect(labels("name", "asc")).toEqual(["Backyard", "Front Door", "Garage"]);
    expect(labels("rate", "asc")).toEqual(["Garage", "Backyard", "Front Door"]);
    expect(labels("uptime", "desc")).toEqual([
      "Front Door",
      "Backyard",
      "Garage",
    ]);
  });

  it("breaks ties on the label, and never sorts in place", () => {
    const tied = [
      row({ camera: "z", label: "Zebra" }),
      row({ camera: "a", label: "Alley" }),
    ];
    expect(sortRows(tied, "share", "asc").map((entry) => entry.label)).toEqual([
      "Alley",
      "Zebra",
    ]);
    expect(tied.map((entry) => entry.label)).toEqual(["Zebra", "Alley"]);
  });

  it("sorts a camera with no rate or share last when ascending", () => {
    const unknown = [
      row({ label: "Known", fps: 1, share: 1 }),
      row({ label: "Unknown", fps: undefined, share: undefined }),
    ];
    expect(sortRows(unknown, "rate", "asc").map((e) => e.label)).toEqual([
      "Unknown",
      "Known",
    ]);
    expect(sortRows(unknown, "share", "asc").map((e) => e.label)).toEqual([
      "Unknown",
      "Known",
    ]);
  });
});

describe("the row sparkline", () => {
  it("drops cells with no samples and keeps the rest in their real place", () => {
    const points = sparklinePoints(series({ fps: [5, null, 4] }), 1000, 300);
    expect(points).toEqual({ values: [5, 4], times: [1000, 1600] });
  });

  it("is empty before any history arrives", () => {
    expect(sparklinePoints(undefined, 1000, 300)).toEqual({
      values: [],
      times: [],
    });
  });
});

describe("the drawer strip", () => {
  it("places evenly spaced ticks across the window, both ends included", () => {
    expect(stripTicks(0, 400, 5)).toEqual([0, 100, 200, 300, 400]);
    expect(stripTicks(1000, 1000)).toEqual([1000]);
    expect(stripTicks(0, 400, 1)).toEqual([0]);
  });

  it("measures a finished incident and leaves an open one undefined", () => {
    expect(incidentDuration(incident())).toBe(600);
    expect(incidentDuration(incident({ end: null }))).toBeUndefined();
    expect(incidentDuration(incident({ start: 2000, end: 1000 }))).toBe(0);
  });

  it("splits a restart into its family and its reason", () => {
    expect(incidentKind(incident())).toEqual({
      family: "outage",
      reason: "other",
    });
    expect(incidentKind(incident({ kind: "restart:hwaccel" }))).toEqual({
      family: "restart",
      reason: "hwaccel",
    });
    expect(incidentKind(incident({ kind: "restart" }))).toEqual({
      family: "restart",
      reason: "other",
    });
  });
});
