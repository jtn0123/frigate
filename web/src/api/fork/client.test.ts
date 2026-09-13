import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@/types/fork/api.gen";

const get = vi.fn<(...args: unknown[]) => Promise<{ data: unknown }>>();
const swrSpy = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("axios", () => ({
  default: { get: (...args: unknown[]) => get(...args) },
}));

vi.mock("swr", () => ({
  default: (...args: unknown[]) => swrSpy(...args),
}));

import { apiGet, eventSpecId, reviewSpecId, swrKey, useApi } from "./client";

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

describe("useApi", () => {
  beforeEach(() => {
    swrSpy.mockReset();
    swrSpy.mockReturnValue({ data: undefined });
  });

  it("passes the axios-relative key and the SWR options through", () => {
    useApi("/stats", { refreshInterval: 1000 });

    expect(swrSpy).toHaveBeenCalledWith("stats", {
      refreshInterval: 1000,
    });
  });

  it("splits params out of the options into the tuple key", () => {
    useApi("/events", { params: { limit: 5 }, revalidateOnFocus: false });

    expect(swrSpy).toHaveBeenCalledWith(["events", { limit: 5 }], {
      revalidateOnFocus: false,
    });
  });

  it("passes a null key through so the read can be skipped", () => {
    useApi(null);

    expect(swrSpy).toHaveBeenCalledWith(null, {});
  });
});

describe("apiGet", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("requests the axios-relative path and unwraps the body", async () => {
    get.mockResolvedValue({ data: [{ id: "review-1" }] });

    const data = await apiGet("/review", { limit: 10 });

    expect(get).toHaveBeenCalledWith("review", { params: { limit: 10 } });
    expect(data).toEqual([{ id: "review-1" }]);
  });
});
