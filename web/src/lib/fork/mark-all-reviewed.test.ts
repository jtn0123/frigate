import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewSegment } from "@/types/review";

const get = vi.fn<(url: string, config: unknown) => Promise<unknown>>();
const post = vi.fn<(url: string, body: unknown) => Promise<unknown>>();

vi.mock("axios", () => ({
  default: {
    get: (url: string, config: unknown) => get(url, config),
    post: (url: string, body: unknown) => post(url, body),
  },
}));

import { markAllUnreviewed } from "./mark-all-reviewed";

function seg(id: string, ended = true): ReviewSegment {
  return {
    id,
    camera: "front_door",
    severity: "alert",
    start_time: 1_000,
    ...(ended ? { end_time: 1_030 } : {}),
    thumb_path: "",
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [],
      objects: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
}

/** Serves the unreviewed list the way the API does, newest first. */
function serve(items: ReviewSegment[]) {
  const reviewed = new Set<string>();
  get.mockImplementation((_url, config) => {
    const { limit } = (config as { params: { limit: number } }).params;
    return Promise.resolve({
      data: items.filter((item) => !reviewed.has(item.id)).slice(0, limit),
    });
  });
  post.mockImplementation((_url, body) => {
    (body as { ids: string[] }).ids.forEach((id) => reviewed.add(id));
    return Promise.resolve({ data: { success: true } });
  });
}

describe("markAllUnreviewed", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("asks for every unreviewed item, not only the last 24 hours", async () => {
    serve([seg("a"), seg("b")]);
    expect(await markAllUnreviewed()).toBe(2);
    expect(get).toHaveBeenCalledWith("review", {
      params: { reviewed: 0, after: 1, limit: 500 },
    });
    expect(post).toHaveBeenCalledWith("reviews/viewed", {
      ids: ["a", "b"],
      reviewed: true,
    });
  });

  it("pages until the unreviewed list is exhausted", async () => {
    serve(["a", "b", "c", "d", "e"].map((id) => seg(id)));
    expect(await markAllUnreviewed(2)).toBe(5);
    expect(post.mock.calls.map(([, body]) => body)).toEqual([
      { ids: ["a", "b"], reviewed: true },
      { ids: ["c", "d"], reviewed: true },
      { ids: ["e"], reviewed: true },
    ]);
  });

  it("leaves items in progress and stops when only they remain", async () => {
    serve([seg("live", false), seg("a"), seg("b", false)]);
    expect(await markAllUnreviewed(2)).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("reviews/viewed", {
      ids: ["a"],
      reviewed: true,
    });
  });

  it("marks nothing when nothing is unreviewed", async () => {
    serve([]);
    expect(await markAllUnreviewed()).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("stops when a page comes back unchanged", async () => {
    get.mockResolvedValue({ data: [seg("a"), seg("b")] });
    post.mockResolvedValue({});
    expect(await markAllUnreviewed(2)).toBe(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
