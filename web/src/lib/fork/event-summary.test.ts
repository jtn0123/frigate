import { describe, expect, it } from "vitest";
import type { Event } from "@/types/event";
import type { ReviewSegment } from "@/types/review";
import type { SearchResult } from "@/types/search";
import {
  summaryFromEvent,
  summaryFromReview,
  summaryFromSearchResult,
} from "./event-summary";

describe("summaryFromSearchResult", () => {
  it("copies camera, labels, times and zones", () => {
    const search = {
      camera: "front_door",
      label: "person",
      sub_label: "john",
      start_time: 1710000000,
      end_time: 1710000030,
      zones: ["porch"],
      data: { type: "object" },
    } as SearchResult;
    expect(summaryFromSearchResult(search)).toEqual({
      camera: "front_door",
      label: "person",
      subLabel: "john",
      startTime: 1710000000,
      endTime: 1710000030,
      type: "object",
      zones: ["porch"],
    });
  });
});

describe("summaryFromEvent", () => {
  it("maps an Event the same way", () => {
    const event = {
      camera: "garage",
      label: "car",
      start_time: 10,
      zones: [],
      data: { type: "object" },
    } as unknown as Event;
    expect(summaryFromEvent(event)).toMatchObject({
      camera: "garage",
      label: "car",
      startTime: 10,
      type: "object",
    });
  });
});

describe("summaryFromReview", () => {
  it("uses the first object label and parses ISO start times", () => {
    const review = {
      camera: "front_door",
      severity: "alert",
      start_time: "2026-06-05T11:30:09.000Z" as unknown as number,
      data: {
        objects: ["person", "car"],
        sub_labels: ["john"],
        zones: ["front_yard"],
      },
    } as unknown as ReviewSegment;
    const summary = summaryFromReview(review);
    expect(summary.camera).toBe("front_door");
    expect(summary.label).toBe("person");
    expect(summary.subLabel).toBe("john");
    expect(summary.zones).toEqual(["front_yard"]);
    expect(summary.startTime).toBe(
      Date.parse("2026-06-05T11:30:09.000Z") / 1000,
    );
  });

  it("falls back to severity when there are no objects", () => {
    const review = {
      camera: "lot",
      severity: "detection",
      start_time: 1,
      data: { objects: [], zones: [] },
    } as unknown as ReviewSegment;
    expect(summaryFromReview(review).label).toBe("detection");
  });
});
