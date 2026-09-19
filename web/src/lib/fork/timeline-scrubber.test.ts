import { describe, expect, it } from "vitest";
import {
  eventTimesFromItems,
  FOLLOW_EDGE_MARGIN,
  isSegmentWellInView,
  SNAP_SEGMENTS,
  snapMaxDistance,
  snapToNearestEvent,
  stepToEvent,
  toUnixTime,
} from "./timeline-scrubber";

describe("toUnixTime", () => {
  it("passes through finite numbers", () => {
    expect(toUnixTime(1710000000)).toBe(1710000000);
  });

  it("parses numeric strings and ISO timestamps", () => {
    expect(toUnixTime("1710000000")).toBe(1710000000);
    expect(toUnixTime("2026-06-05T11:30:09.000Z")).toBe(
      Date.parse("2026-06-05T11:30:09.000Z") / 1000,
    );
  });

  it("returns undefined for empty or invalid values", () => {
    expect(toUnixTime(undefined)).toBeUndefined();
    expect(toUnixTime("")).toBeUndefined();
    expect(toUnixTime("not-a-time")).toBeUndefined();
    expect(toUnixTime(Number.NaN)).toBeUndefined();
  });
});

describe("eventTimesFromItems", () => {
  it("sorts unique unix times and drops invalid entries", () => {
    expect(
      eventTimesFromItems([
        { start_time: 30 },
        { start_time: 10 },
        { start_time: 30 },
        { start_time: "nope" },
        { start_time: 20 },
      ]),
    ).toEqual([10, 20, 30]);
  });
});

describe("snapToNearestEvent", () => {
  const events = [100, 200, 400];

  it("returns the input when there are no events", () => {
    expect(snapToNearestEvent(150, [])).toBe(150);
  });

  it("snaps to the closest event time", () => {
    expect(snapToNearestEvent(140, events)).toBe(100);
    expect(snapToNearestEvent(160, events)).toBe(200);
    expect(snapToNearestEvent(350, events)).toBe(400);
  });

  it("ties go to the earlier event", () => {
    expect(snapToNearestEvent(150, [100, 200])).toBe(100);
  });

  it("leaves the time alone when farther than maxDistance", () => {
    expect(snapToNearestEvent(250, events, 40)).toBe(250);
    expect(snapToNearestEvent(230, events, 40)).toBe(200);
  });
});

describe("snapMaxDistance", () => {
  it("reaches a few segments at every zoom level", () => {
    expect(snapMaxDistance(30)).toBe(30 * SNAP_SEGMENTS);
    expect(snapMaxDistance(5)).toBe(5 * SNAP_SEGMENTS);
  });

  it("keeps a release hours from any review where it was dropped", () => {
    const review = 9 * 3600 + 12 * 60;
    const release = 14 * 3600 + 30 * 60;
    expect(snapToNearestEvent(release, [review], snapMaxDistance(30))).toBe(
      release,
    );
    expect(snapToNearestEvent(review + 45, [review], snapMaxDistance(30))).toBe(
      review,
    );
  });
});

describe("stepToEvent", () => {
  const events = [100, 200, 400];

  it("returns the input when there are no events", () => {
    expect(stepToEvent(150, [], 1)).toBe(150);
  });

  it("steps forward to the next later event", () => {
    expect(stepToEvent(100, events, 1)).toBe(200);
    expect(stepToEvent(150, events, 1)).toBe(200);
    expect(stepToEvent(400, events, 1)).toBe(400);
  });

  it("steps backward to the previous earlier event", () => {
    expect(stepToEvent(400, events, -1)).toBe(200);
    expect(stepToEvent(250, events, -1)).toBe(200);
    expect(stepToEvent(100, events, -1)).toBe(100);
  });
});

describe("isSegmentWellInView", () => {
  // an 800 px rail scrolled to 1000 px shows segments from 1000 to 1800
  const scrollTop = 1000;
  const height = 800;

  it("accepts a segment in the middle of the rail", () => {
    expect(isSegmentWellInView(1400, 8, scrollTop, height)).toBe(true);
  });

  it("rejects a segment on the last visible row", () => {
    expect(isSegmentWellInView(1792, 8, scrollTop, height)).toBe(false);
  });

  it("rejects a segment within the margin of either edge", () => {
    expect(
      isSegmentWellInView(
        scrollTop + FOLLOW_EDGE_MARGIN - 8,
        8,
        scrollTop,
        height,
      ),
    ).toBe(false);
    expect(
      isSegmentWellInView(
        scrollTop + height - FOLLOW_EDGE_MARGIN - 4,
        8,
        scrollTop,
        height,
      ),
    ).toBe(false);
  });

  it("accepts a segment right at the margin", () => {
    expect(
      isSegmentWellInView(scrollTop + FOLLOW_EDGE_MARGIN, 8, scrollTop, height),
    ).toBe(true);
    expect(
      isSegmentWellInView(
        scrollTop + height - FOLLOW_EDGE_MARGIN - 8,
        8,
        scrollTop,
        height,
      ),
    ).toBe(true);
  });

  it("rejects segments outside the viewport", () => {
    expect(isSegmentWellInView(0, 8, scrollTop, height)).toBe(false);
    expect(isSegmentWellInView(4000, 8, scrollTop, height)).toBe(false);
  });

  it("shrinks the margin on a rail too short for it", () => {
    // 48 px tall: only the middle segments count, never none of them
    expect(isSegmentWellInView(20, 8, 0, 48)).toBe(true);
    expect(isSegmentWellInView(0, 8, 0, 48)).toBe(false);
  });
});
