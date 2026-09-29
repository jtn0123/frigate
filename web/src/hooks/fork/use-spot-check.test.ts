import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoFiledGroup } from "@/lib/fork/classification-suggestions";
import { useSpotCheck } from "./use-spot-check";

const axiosPost = vi.fn<(url: string, body: unknown) => Promise<unknown>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
const mutate = vi.fn();

vi.mock("axios", () => ({
  default: { post: (url: string, body: unknown) => axiosPost(url, body) },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("swr", () => ({
  mutate: (...args: unknown[]): unknown => mutate(...args),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const GROUP: AutoFiledGroup = {
  time: 1,
  event_id: "evt-1",
  camera: "yard",
  category: "suv",
  source: "jev",
  score: 0.97,
  files: ["suv-a.png", "suv-b.png"],
};

describe("useSpotCheck", () => {
  beforeEach(() => {
    axiosPost.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    mutate.mockReset();
  });

  it("posts the verdict and refreshes the report", async () => {
    axiosPost.mockResolvedValue({});
    const { result } = renderHook(() => useSpotCheck("vehicle_type"));
    await expect(result.current(GROUP, false)).resolves.toBe(true);
    expect(axiosPost).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/spot-check",
      {
        event_id: "evt-1",
        category: "suv",
        files: ["suv-a.png", "suv-b.png"],
        keep: false,
      },
    );
    expect(toastSuccess.mock.calls[0]?.[0]).toBe(
      'classificationSuggestions.report.removedGroup:{"count":2,"category":"suv"}',
    );
    expect(mutate).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/report",
    );
    await result.current({ ...GROUP, event_id: null }, true);
    expect(axiosPost.mock.calls[1]?.[1]).toMatchObject({
      event_id: "",
      keep: true,
    });
    expect(toastSuccess.mock.calls[1]?.[0]).toContain("keptGroup");
  });

  it("toasts and resolves false when the call fails", async () => {
    axiosPost.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useSpotCheck("vehicle_type"));
    await expect(result.current(GROUP, true)).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });
});
