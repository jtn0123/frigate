import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useLivePlaybackStatus,
  LIVE_STARTUP_TIMEOUT_MS,
} from "./use-live-playback-status";

afterEach(() => vi.useRealTimers());

describe("live playback status", () => {
  it("ends loading when codec negotiation succeeds but no frame plays", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useLivePlaybackStatus("side:mse", true),
    );
    act(() => {
      vi.advanceTimersByTime(LIVE_STARTUP_TIMEOUT_MS);
    });
    expect(result.current.failure).toBe("startup");
  });

  it("does not time out a player that delivered a frame", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useLivePlaybackStatus("side:mse", true),
    );
    act(() => result.current.onPlaying());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.failure).toBeUndefined();
  });

  it("reports decoding errors immediately and retries the same stream", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useLivePlaybackStatus("side:mse", true),
    );
    act(() => result.current.onError("mse-decode"));
    expect(result.current.failure).toBe("mse-decode");
    act(() => result.current.retry());
    expect(result.current.failure).toBeUndefined();
    expect(result.current.attempt).toBe(1);
    act(() => {
      vi.advanceTimersByTime(LIVE_STARTUP_TIMEOUT_MS);
    });
    expect(result.current.failure).toBe("startup");
  });

  it("does not time out disabled or hidden playback", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useLivePlaybackStatus("side:mse", false),
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.failure).toBeUndefined();
  });

  it("clears the old camera failure when switching streams", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ name }) => useLivePlaybackStatus(name, true),
      { initialProps: { name: "side:mse" } },
    );
    act(() => result.current.onError("mse-decode"));
    rerender({ name: "backyard:mse" });
    expect(result.current.failure).toBeUndefined();
  });
});
