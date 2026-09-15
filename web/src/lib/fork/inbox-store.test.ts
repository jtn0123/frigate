import { beforeEach, describe, expect, it } from "vitest";
import type { FrigateReview } from "@/types/ws";
import type { ReviewSegment } from "@/types/review";
import {
  INBOX_DISMISSED_KEY,
  INBOX_MAX_DISMISSED,
  clearInbox,
  getInboxState,
  ingestReview,
  reloadInboxFromStorage,
  removeInboxItem,
} from "./inbox-store";

function message(id: string, type: FrigateReview["type"]): FrigateReview {
  const segment: ReviewSegment = {
    id,
    camera: "front_door",
    severity: "alert",
    start_time: 1_000,
    ...(type === "end" ? { end_time: 1_030 } : {}),
    thumb_path: `/media/frigate/clips/review/thumb-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
  return { type, before: segment, after: segment };
}

function ids() {
  return getInboxState().items.map((item) => item.id);
}

describe("inbox store", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadInboxFromStorage();
  });

  it("adds an item for a new review and updates it afterwards", () => {
    expect(ingestReview(message("r1", "new"))).toBe(true);
    expect(ingestReview(message("r1", "end"))).toBe(true);
    expect(ids()).toEqual(["r1"]);
    expect(getInboxState().items.at(0)?.endTime).toBe(1_030);
  });

  it("does not add an item from an update whose start it never saw", () => {
    expect(ingestReview(message("r1", "update"))).toBe(false);
    expect(ids()).toEqual([]);
  });

  it("keeps a dismissed review out while it is still active", () => {
    ingestReview(message("r1", "new"));
    removeInboxItem("r1");

    // the reviews topic keeps sending updates, and the collector re-ingests
    // the last message when it remounts
    expect(ingestReview(message("r1", "update"))).toBe(false);
    expect(ingestReview(message("r1", "new"))).toBe(false);
    expect(ingestReview(message("r1", "end"))).toBe(false);
    expect(ids()).toEqual([]);
  });

  it("keeps cleared reviews out", () => {
    ingestReview(message("r1", "new"));
    ingestReview(message("r2", "new"));
    clearInbox();

    ingestReview(message("r1", "update"));
    ingestReview(message("r2", "new"));
    expect(ids()).toEqual([]);

    ingestReview(message("r3", "new"));
    expect(ids()).toEqual(["r3"]);
  });

  it("remembers dismissed reviews across a reload, keeping the newest", () => {
    ingestReview(message("r1", "new"));
    removeInboxItem("r1");
    reloadInboxFromStorage();
    ingestReview(message("r1", "new"));
    expect(ids()).toEqual([]);

    for (let i = 0; i < INBOX_MAX_DISMISSED; i++) {
      ingestReview(message(`d${i}`, "new"));
      removeInboxItem(`d${i}`);
    }
    const stored: unknown = JSON.parse(
      localStorage.getItem(INBOX_DISMISSED_KEY) ?? "[]",
    );
    expect(stored).toHaveLength(INBOX_MAX_DISMISSED);

    // r1 was the oldest dismissal and has been dropped
    ingestReview(message("r1", "new"));
    expect(ids()).toEqual(["r1"]);
  });
});
