import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGo2rtcState } from "./use-go2rtc-state";

const swr = vi.hoisted(() => ({ useSWR: vi.fn() }));
vi.mock("swr", () => ({ default: swr.useSWR }));

describe("go2rtc state requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("polls every 30 seconds while enabled and passes the response on", () => {
    const data = { available: true, updated: 1, cameras: {} };
    swr.useSWR.mockReturnValue({ data, error: undefined, isLoading: false });
    const { result } = renderHook(() => useGo2rtcState(true));
    expect(swr.useSWR).toHaveBeenLastCalledWith("fork/go2rtc_state", {
      revalidateOnFocus: false,
      refreshInterval: 30_000,
      keepPreviousData: true,
    });
    expect(result.current).toEqual({
      data,
      error: undefined,
      isLoading: false,
    });
  });

  it("does not request anything while disabled", () => {
    swr.useSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
    const { rerender } = renderHook(({ enabled }) => useGo2rtcState(enabled), {
      initialProps: { enabled: false },
    });
    expect(swr.useSWR).toHaveBeenLastCalledWith(null, expect.anything());
    rerender({ enabled: true });
    expect(swr.useSWR).toHaveBeenLastCalledWith(
      "fork/go2rtc_state",
      expect.anything(),
    );
  });

  it("preserves loading and errors", () => {
    const error = new Error("unavailable");
    swr.useSWR.mockReturnValue({ data: undefined, error, isLoading: true });
    const { result } = renderHook(() => useGo2rtcState(true));
    expect(result.current).toEqual({ data: undefined, error, isLoading: true });
  });
});
