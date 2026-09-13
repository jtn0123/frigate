import { describe, expect, it } from "vitest";
import type { components } from "@/types/fork/api.gen";
import { eventSpecId, reviewSpecId, swrKey } from "./client";

describe("swrKey", () => {
  it("keeps the axios-relative keys the rest of the app already uses", () => {
    expect(swrKey("/config")).toBe("config");
    expect(swrKey("/stats")).toBe("stats");
    expect(swrKey("/review", { limit: 10, severity: "alert" })).toEqual([
      "review",
      { limit: 10, severity: "alert" },
    ]);
    expect(swrKey("/events", {})).toEqual(["events", {}]);
  });
});

describe("spec field handles", () => {
  it("reads ids off the generated review and event schemas", () => {
    const review: components["schemas"]["ReviewSegmentResponse"] = {
      id: "review-1",
      camera: "front_door",
      start_time: "2026-06-05T11:30:09.365581",
      end_time: "2026-06-05T11:30:39.365581",
      has_been_reviewed: false,
      severity: "alert",
      thumb_path: "/thumb.jpg",
      data: {},
    };
    const event: components["schemas"]["EventResponse"] = {
      id: "event-1",
      label: "person",
      sub_label: null,
      camera: "front_door",
      start_time: 1,
      end_time: 2,
      false_positive: false,
      zones: [],
      thumbnail: null,
      has_clip: true,
      has_snapshot: true,
      retain_indefinitely: false,
      plus_id: null,
      model_hash: null,
      detector_type: null,
      model_type: null,
      data: {},
    };
    expect(reviewSpecId(review)).toBe("review-1");
    expect(eventSpecId(event)).toBe("event-1");
  });
});
