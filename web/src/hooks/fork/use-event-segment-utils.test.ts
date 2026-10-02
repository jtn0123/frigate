import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewSegment, ReviewSeverity } from "@/types/review";
import { useEventSegmentUtils } from "@/hooks/use-event-segment-utils";

function segment(
  id: string,
  severity: ReviewSeverity,
  start_time: number,
  end_time?: number,
  has_been_reviewed = false,
): ReviewSegment {
  return {
    id,
    camera: "front",
    severity,
    start_time,
    ...(end_time === undefined ? {} : { end_time }),
    thumb_path: "",
    has_been_reviewed,
    data: {
      audio: [],
      detections: [],
      objects: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

function utils(events: ReviewSegment[], severityType = "alert") {
  return renderHook(() => useEventSegmentUtils(30, events, severityType)).result
    .current;
}

afterEach(() => vi.useRealTimers());

describe("useEventSegmentUtils", () => {
  it("aligns times to segment bounds", () => {
    const u = utils([]);
    expect(u.getSegmentStart(95)).toBe(90);
    expect(u.getSegmentEnd(95)).toBe(120);
  });

  it("ends an ongoing event one segment after now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(utils([]).getSegmentEnd(undefined)).toBe(1000 + 30);
  });

  it.each([
    ["significant_motion", 1],
    ["detection", 2],
    ["alert", 3],
    ["other", 0],
  ])("maps the %s display severity to %i", (severity, value) => {
    expect(utils([], severity).displaySeverityType).toBe(value);
  });

  it("reports the display severity with the highest other severity", () => {
    const u = utils([
      segment("d", "detection", 60, 100),
      segment("a", "alert", 90, 100),
      segment("m", "significant_motion", 60, 100),
    ]);
    // the detection is seen before the alert, so it is kept as the
    // secondary severity
    expect(u.getSeverity(95, 3)).toEqual([3, 2]);
  });

  it("reports the highest other severity or zero", () => {
    const u = utils([
      segment("m", "significant_motion", 0, 20),
      segment("d", "detection", 0, 20),
    ]);
    expect(u.getSeverity(10, 3)).toEqual([2]);
    expect(u.getSeverity(500, 3)).toEqual([0]);
  });

  it("detects reviewed segments", () => {
    const u = utils([
      segment("a", "alert", 0, 20, true),
      segment("b", "alert", 60, 80, false),
    ]);
    expect(u.getReviewed(10)).toBe(true);
    expect(u.getReviewed(70)).toBe(false);
    expect(u.getReviewed(200)).toBe(false);
  });

  it("rounds the ends of primary and secondary runs", () => {
    const u = utils([
      segment("a", "alert", 30, 89),
      segment("d", "detection", 60, 65),
    ]);
    // alert covers segments 30, 60; detection covers 60 only
    expect(u.shouldShowRoundedCorners(30)).toEqual({
      roundTopPrimary: false,
      roundBottomPrimary: true,
      roundTopSecondary: false,
      roundBottomSecondary: false,
    });
    expect(u.shouldShowRoundedCorners(60)).toEqual({
      roundTopPrimary: true,
      roundBottomPrimary: false,
      roundTopSecondary: true,
      roundBottomSecondary: true,
    });
    expect(u.shouldShowRoundedCorners(300)).toEqual({
      roundTopPrimary: false,
      roundBottomPrimary: false,
      roundTopSecondary: false,
      roundBottomSecondary: false,
    });
  });

  it("finds the event of the display severity at a time", () => {
    const alert = segment("a", "alert", 30, 50);
    const u = utils([segment("d", "detection", 30, 50), alert]);
    expect(u.getEvent(40)).toBe(alert);
    expect(u.getEventStart(40)).toBe(30);
    expect(u.getEvent(100)).toBeUndefined();
    expect(u.getEventStart(100)).toBe(0);
  });
});
