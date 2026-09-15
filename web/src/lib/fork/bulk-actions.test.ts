import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn<(...args: unknown[]) => Promise<{ status: number }>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();

vi.mock("axios", () => ({
  default: { post: (...args: unknown[]) => post(...args) },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("i18next", () => ({
  default: {
    t: (key: string) => key,
  },
}));

import type { ReviewSegment } from "@/types/review";
import { changedReviewIds, markReviewedWithUndo } from "./bulk-actions";

function review(id: string, hasBeenReviewed: boolean): ReviewSegment {
  return {
    id,
    camera: "front_door",
    severity: "alert",
    start_time: 1_000,
    end_time: 1_030,
    thumb_path: "",
    has_been_reviewed: hasBeenReviewed,
    data: {
      audio: [],
      detections: [],
      objects: ["person"],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

describe("changedReviewIds", () => {
  const mixed = [review("a", false), review("b", true), review("c", false)];

  it("keeps only the items a mark would change", () => {
    expect(changedReviewIds(mixed, true)).toEqual(["a", "c"]);
    expect(changedReviewIds(mixed, false)).toEqual(["b"]);
  });

  it("is empty when nothing would change", () => {
    expect(changedReviewIds([review("b", true)], true)).toEqual([]);
  });
});

describe("markReviewedWithUndo", () => {
  beforeEach(() => {
    post.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    post.mockResolvedValue({ status: 200 });
  });

  it("posts the viewed change and exposes an Undo action that reverts it", async () => {
    const onReverted = vi.fn();
    await markReviewedWithUndo(["a", "b"], true, onReverted);

    expect(post).toHaveBeenCalledWith("reviews/viewed", {
      ids: ["a", "b"],
      reviewed: true,
    });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const toastArg = toastSuccess.mock.calls.at(0)?.at(1) as
      { action?: { onClick: () => Promise<void> } } | undefined;
    expect(toastArg?.action).toBeDefined();

    await toastArg?.action?.onClick();
    expect(post).toHaveBeenNthCalledWith(2, "reviews/viewed", {
      ids: ["a", "b"],
      reviewed: false,
    });
    expect(onReverted).toHaveBeenCalledTimes(1);
  });

  it("still posts when the list is empty but skips the toast", async () => {
    await markReviewedWithUndo([], true, vi.fn());
    expect(post).toHaveBeenCalledWith("reviews/viewed", {
      ids: [],
      reviewed: true,
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
