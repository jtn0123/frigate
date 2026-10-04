import { describe, expect, it } from "vitest";
import type { ReviewSegment } from "@/types/review";
import {
  EMPTY_CONTEXT,
  groupMembers,
  groupSpotlights,
  rankSpotlights,
} from "./spotlights";
import {
  REFRESH_DEBOUNCE_MS,
  REFRESH_MIN_GAP_MS,
  addReviews,
  firstArrival,
  mergeReviews,
  pinFeed,
  readPinned,
  refreshDelay,
} from "./spotlights-live";

const NOW = 1_790_000_000;

function review(
  id: string,
  overrides: Partial<ReviewSegment> = {},
): ReviewSegment {
  return {
    id,
    camera: "front_door",
    severity: "alert",
    start_time: NOW - 600,
    end_time: NOW - 570,
    thumb_path: `/media/frigate/clips/review/thumb-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [`${id}-obj`],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
    ...overrides,
  };
}

describe("refreshDelay", () => {
  it("lets a burst settle, then spaces refreshes out", () => {
    expect(refreshDelay(10_000, undefined)).toBe(REFRESH_DEBOUNCE_MS);
    // the last refresh was long ago
    expect(refreshDelay(100_000, 10_000)).toBe(REFRESH_DEBOUNCE_MS);
    // the last one ran 5 s ago, so wait out the rest of the gap
    expect(refreshDelay(15_000, 10_000)).toBe(REFRESH_MIN_GAP_MS - 5_000);
  });
});

describe("merging reads", () => {
  it("keeps the newest copy of each item", () => {
    const first = addReviews(new Map(), [review("a"), review("b")]);
    const ended = review("a", { end_time: NOW });
    const next = addReviews(first, [ended]);
    expect(next.get("a")).toBe(ended);
    expect(next.get("b")).toBe(first.get("b"));
    // the earlier map is left alone, so React sees a new one
    expect(first.get("a")).not.toBe(ended);
  });

  it("updates the first read in place and adds what is new", () => {
    const a = review("a");
    const base = [a, review("b")];
    const withMetadata = review("b", {
      data: {
        ...a.data,
        metadata: {
          title: "Person at the door",
          scene: "",
          confidence: 0.9,
          potential_threat_level: 1,
        },
      },
    });
    const merged = mergeReviews(
      base,
      new Map([
        ["b", withMetadata],
        ["c", review("c")],
      ]),
    );
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(merged.at(1)).toBe(withMetadata);
    expect(merged.at(0)).toBe(a);
    expect(mergeReviews(base, new Map())).toEqual(base);
  });
});

describe("pinned feed", () => {
  const rank = (reviews: ReviewSegment[]) =>
    rankSpotlights(reviews, EMPTY_CONTEXT).items;

  it("holds new items back and keeps the shown order", () => {
    const pin = pinFeed(
      rank([
        review("older", { start_time: NOW - 900 }),
        review("newer", { start_time: NOW - 300 }),
      ]),
    );
    expect(pin.ids).toEqual(["newer", "older"]);

    // a glass break arrives and would rank first
    const latest = rank([
      review("older", { start_time: NOW - 900 }),
      review("newer", { start_time: NOW - 300 }),
      review("glass", {
        start_time: NOW - 60,
        data: { ...review("x").data, audio: ["glass"] },
      }),
    ]);
    expect(latest.at(0)?.review.id).toBe("glass");
    const view = readPinned(pin, latest);
    expect(view.items.map((item) => item.review.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(view.fresh).toBe(1);
    expect(view.freshIds).toEqual(["glass"]);

    // showing them pins the new ranking
    const shown = readPinned(pinFeed(latest), latest);
    expect(shown.items.map((item) => item.review.id)).toEqual([
      "glass",
      "newer",
      "older",
    ]);
    expect(shown.fresh).toBe(0);
    expect(shown.freshIds).toEqual([]);
  });

  it("updates a shown card in place without moving it", () => {
    const pin = pinFeed(
      rank([
        review("first", { start_time: NOW - 100 }),
        review("second", { start_time: NOW - 200 }),
      ]),
    );
    // a GenAI threat level lands on the second; it would now rank first
    const latest = rank([
      review("first", { start_time: NOW - 100 }),
      review("second", {
        start_time: NOW - 200,
        data: {
          ...review("x").data,
          metadata: {
            title: "Person tries the gate",
            scene: "",
            confidence: 0.9,
            potential_threat_level: 2,
          },
        },
      }),
    ]);
    const view = readPinned(pin, latest);
    expect(view.items.map((item) => item.review.id)).toEqual([
      "first",
      "second",
    ]);
    expect(view.items.at(1)?.reasons.at(0)).toEqual({
      kind: "threat",
      level: 2,
    });
    expect(view.fresh).toBe(0);
  });

  it("keeps a card that slid out of the window until the next showing", () => {
    const items = rank([review("old"), review("kept")]);
    const view = readPinned(
      pinFeed(items),
      items.filter((item) => item.review.id === "kept"),
    );
    expect(view.items.map((item) => item.review.id).sort()).toEqual([
      "kept",
      "old",
    ]);
  });
});

describe("firstArrival", () => {
  const groups = (reviews: ReviewSegment[]) =>
    groupSpotlights(rankSpotlights(reviews, EMPTY_CONTEXT).items);

  it("finds the card a new item landed on, wherever it ranks", () => {
    const shown = groups([
      review("glass", {
        start_time: NOW - 900,
        data: { ...review("x").data, audio: ["glass"] },
      }),
      review("older", { start_time: NOW - 600 }),
      // a plain alert that just ended ranks below the glass break
      review("plain", { start_time: NOW - 60 }),
    ]);
    expect(shown.map((group) => group.lead.review.id)).toEqual([
      "glass",
      "plain",
      "older",
    ]);
    expect(firstArrival(shown, new Set(["plain"]))).toBe(1);
    expect(firstArrival(shown, new Set(["gone"]))).toBe(-1);
  });

  it("marks the group a repeat joined", () => {
    const visit = { ...review("x").data, detections: ["same-person"] };
    const shown = groups([
      review("first", { start_time: NOW - 900, data: visit }),
      review("other", { start_time: NOW - 800 }),
      review("again", { start_time: NOW - 60, data: visit }),
    ]);
    expect(shown).toHaveLength(2);
    const visitCard = shown.findIndex((group) =>
      groupMembers(group).some((item) => item.review.id === "first"),
    );
    expect(visitCard).toBeGreaterThanOrEqual(0);
    expect(firstArrival(shown, new Set(["again"]))).toBe(visitCard);
  });
});
