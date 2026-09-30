import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLogSummary } from "./use-log-summary";

const swr = vi.hoisted(() => ({
  useSWR: vi.fn(),
  mutate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("swr", () => ({ default: swr.useSWR }));

describe("log summary requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for a day, and for one camera when the log is filtered", () => {
    const error = new Error("unavailable");
    swr.useSWR.mockReturnValue({
      data: undefined,
      error,
      isLoading: true,
      mutate: swr.mutate,
    });
    const { result, rerender } = renderHook(
      ({ camera }) => useLogSummary(true, camera),
      { initialProps: { camera: "" } },
    );
    expect(result.current).toMatchObject({
      data: undefined,
      error,
      isLoading: true,
    });
    expect(swr.useSWR).toHaveBeenLastCalledWith(
      ["fork/log_summary", { hours: 24 }],
      {
        revalidateOnFocus: false,
        refreshInterval: 60_000,
        keepPreviousData: true,
      },
    );
    rerender({ camera: "doorbell" });
    expect(swr.useSWR).toHaveBeenLastCalledWith(
      ["fork/log_summary", { hours: 24, camera: "doorbell" }],
      expect.anything(),
    );
  });

  it("skips the request while disabled", () => {
    swr.useSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: swr.mutate,
    });
    renderHook(() => useLogSummary(false));
    expect(swr.useSWR).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it("exposes the response and retries through the cache", () => {
    const data = { hours: 24, groups: [] };
    swr.useSWR.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      mutate: swr.mutate,
    });
    const { result } = renderHook(() => useLogSummary(true));
    expect(result.current.data).toBe(data);
    act(() => result.current.refresh());
    expect(swr.mutate).toHaveBeenCalledOnce();
  });
});
