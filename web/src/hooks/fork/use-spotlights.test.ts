import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrigateReview } from "@/types/ws";
import type { ReviewSegment } from "@/types/review";
import {
  REFRESH_DEBOUNCE_MS,
  REFRESH_MIN_GAP_MS,
  REFRESH_OVERLAP_SECONDS,
  REFRESH_POLL_MS,
} from "@/lib/fork/spotlights-live";
import { useSpotlights } from "./use-spotlights";

const mocks = vi.hoisted(() => ({
  base: [] as unknown[],
  apiGet: vi.fn(),
  mutate: vi.fn(),
  update: undefined as unknown,
  post: vi.fn(),
}));

vi.mock("@/api/fork/client", () => ({
  useApi: (path: string | null) => {
    if (path === "/config") {
      return { data: CONFIG };
    }
    if (path === "/review") {
      return { data: mocks.base, error: undefined, mutate: mocks.mutate };
    }
    return { data: undefined, error: undefined, mutate: vi.fn() };
  },
  apiGet: mocks.apiGet,
}));

vi.mock("@/api/ws", () => ({
  useFrigateReviews: () => mocks.update,
}));

vi.mock("axios", () => ({ default: { post: mocks.post } }));

const CONFIG = {
  lpr: { enabled: false },
  face_recognition: { enabled: true },
  cameras: {
    front_door: { lpr: { enabled: false }, face_recognition: {} },
    garage: { lpr: { enabled: false }, face_recognition: {} },
  },
};

const START = new Date("2026-10-03T12:00:30Z");
const NOW = Math.floor(START.getTime() / 1000);

function review(
  id: string,
  overrides: Partial<ReviewSegment> & { audio?: string[] } = {},
): ReviewSegment {
  const { audio = [], ...rest } = overrides;
  return {
    id,
    camera: "front_door",
    severity: "alert",
    start_time: NOW - 600,
    end_time: NOW - 570,
    thumb_path: `/media/frigate/clips/review/thumb-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio,
      detections: [`${id}-obj`],
      objects: ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
    ...rest,
  };
}

function message(after: ReviewSegment): FrigateReview {
  return { type: "end", before: after, after };
}

/** Lets the refresh's promise chain and the state update land. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ids = (items: { review: ReviewSegment }[] | undefined) =>
  items?.map((item) => item.review.id);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  mocks.base = [];
  mocks.update = undefined;
  mocks.apiGet.mockReset();
  mocks.post.mockReset().mockResolvedValue({ data: { success: true } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSpotlights freshness", () => {
  it("asks only for what changed when a review update arrives", async () => {
    mocks.base = [review("a")];
    const glass = review("glass", {
      start_time: NOW - 40,
      end_time: NOW - 5,
      audio: ["glass"],
    });
    mocks.apiGet.mockResolvedValue([review("a"), glass]);
    const { result, rerender } = renderHook(() =>
      useSpotlights({ range: "24h", cameras: undefined }),
    );
    expect(ids(result.current.items)).toEqual(["a"]);

    mocks.update = message(glass);
    rerender();
    expect(mocks.apiGet).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    });
    await settle();

    // from the first read on, not the whole day again
    const minute = Math.floor(NOW / 60) * 60;
    expect(mocks.apiGet).toHaveBeenCalledWith("/review", {
      after: minute - REFRESH_OVERLAP_SECONDS,
      cameras: "all",
    });
    // held back so nothing moves under the pointer
    expect(ids(result.current.items)).toEqual(["a"]);
    expect(result.current.fresh).toBe(1);

    act(() => result.current.showFresh());
    expect(ids(result.current.items)).toEqual(["glass", "a"]);
    expect(result.current.fresh).toBe(0);
  });

  it("reaches back to an item a late GenAI description lands on", async () => {
    mocks.base = [review("a")];
    mocks.apiGet.mockResolvedValue([]);
    const { rerender } = renderHook(() =>
      useSpotlights({ range: "24h", cameras: undefined }),
    );
    // ended an hour ago, long before the next refresh would start
    mocks.update = message(review("a", { end_time: NOW - 3600 }));
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    });
    expect(mocks.apiGet).toHaveBeenCalledWith("/review", {
      after: NOW - 3600 - 1,
      cameras: "all",
    });
  });

  it("folds a burst into one refresh and spaces the next one out", async () => {
    mocks.base = [review("a")];
    mocks.apiGet.mockResolvedValue([]);
    const { rerender } = renderHook(() =>
      useSpotlights({ range: "24h", cameras: undefined }),
    );
    for (const id of ["u1", "u2", "u3"]) {
      mocks.update = message(review(id));
      rerender();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    });
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);

    mocks.update = message(review("u4"));
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
    });
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MIN_GAP_MS);
    });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
  });

  it("ignores updates from cameras outside the filter", async () => {
    mocks.base = [review("a")];
    mocks.apiGet.mockResolvedValue([]);
    const cameras = ["front_door"];
    const { rerender } = renderHook(() =>
      useSpotlights({ range: "24h", cameras }),
    );
    mocks.update = message(review("g", { camera: "garage" }));
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS * 2);
    });
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it("slides the window instead of freezing it at page load", async () => {
    // ended 23 h 50 min ago: inside the window when the page opened
    mocks.base = [
      review("old", {
        start_time: NOW - 86_400 + 500,
        end_time: NOW - 86_400 + 600,
      }),
      review("recent"),
    ];
    mocks.apiGet.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useSpotlights({ range: "24h", cameras: undefined }),
    );
    expect(ids(result.current.items)).toEqual(["recent", "old"]);

    // twenty minutes of the slow poll, with no websocket message at all
    for (let tick = 0; tick < 20; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_POLL_MS);
      });
      await settle();
    }
    expect(mocks.apiGet.mock.calls.length).toBeGreaterThanOrEqual(10);
    // still shown until the reader asks for the update
    expect(ids(result.current.items)).toEqual(["recent", "old"]);
    act(() => result.current.showFresh());
    expect(ids(result.current.items)).toEqual(["recent"]);
    expect(result.current.timeRange.before).toBeGreaterThan(NOW + 15 * 60);
  });

  it("marks a whole group reviewed and keeps it in place", async () => {
    mocks.base = [
      review("best", { audio: ["glass"] }),
      review("next", { start_time: NOW - 300 }),
    ];
    const { result } = renderHook(() =>
      useSpotlights({ range: "24h", cameras: undefined }),
    );
    const [best, next] = mocks.base as [ReviewSegment, ReviewSegment];
    await act(async () => {
      await result.current.setReviewed([best, next], true);
    });
    expect(mocks.post).toHaveBeenCalledWith("reviews/viewed", {
      ids: ["best", "next"],
      reviewed: true,
    });
    const items = result.current.items ?? [];
    expect(ids(items)).toEqual(["best", "next"]);
    expect(
      items.every((item) =>
        item.reasons.every((reason) => reason.kind !== "unreviewed"),
      ),
    ).toBe(true);

    await act(async () => {
      await result.current.setReviewed([next], false);
    });
    expect(
      result.current.items
        ?.at(1)
        ?.reasons.some((reason) => reason.kind === "unreviewed"),
    ).toBe(true);
  });
});
