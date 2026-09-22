import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraHistory } from "./use-camera-history";

const api = vi.hoisted(() => ({
  useApi: vi.fn(),
  mutate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/fork/client", () => ({ useApi: api.useApi }));

describe("camera history requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves loading and errors while requesting the selected range", () => {
    const error = new Error("unavailable");
    api.useApi.mockReturnValue({
      data: undefined,
      error,
      isLoading: true,
      mutate: api.mutate,
    });
    const { result, rerender } = renderHook(
      ({ range }) => useCameraHistory(range),
      {
        initialProps: { range: "1h" as "1h" | "7d" },
      },
    );
    expect(result.current).toMatchObject({
      data: undefined,
      error,
      isLoading: true,
    });
    expect(api.useApi).toHaveBeenLastCalledWith("/fork/camera_history", {
      params: { range: "1h" },
      revalidateOnFocus: false,
      refreshInterval: 60_000,
      keepPreviousData: true,
    });
    rerender({ range: "7d" });
    expect(api.useApi).toHaveBeenLastCalledWith(
      "/fork/camera_history",
      expect.objectContaining({ params: { range: "7d" } }),
    );
  });

  it("exposes the response and retries through the API cache", () => {
    const data = { range: "24h", cameras: {} };
    api.useApi.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      mutate: api.mutate,
    });
    const { result } = renderHook(() => useCameraHistory("24h"));
    expect(result.current.data).toBe(data);
    act(() => result.current.refresh());
    expect(api.mutate).toHaveBeenCalledOnce();
  });
});
