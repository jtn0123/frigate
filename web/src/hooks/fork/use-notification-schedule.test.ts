import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./use-notification-schedule";

// 20:37:50 in Los Angeles; minute boundaries are the same in every zone
const OPENED = "2026-10-03T03:37:50.000Z";

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    vi.setSystemTime(new Date(OPENED));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks as the next minute starts, not 30 seconds after opening", () => {
    const { result } = renderHook(() => useNow());
    expect(result.current.toISOString()).toBe(OPENED);

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(result.current.toISOString()).toBe(OPENED);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.getTime()).toBeGreaterThanOrEqual(
      Date.parse("2026-10-03T03:38:00.000Z"),
    );
    expect(result.current.getTime()).toBeLessThan(
      Date.parse("2026-10-03T03:38:01.000Z"),
    );
  });

  it("keeps ticking on each half minute", () => {
    const { result } = renderHook(() => useNow());
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    const first = result.current.getTime();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.getTime() - first).toBe(30_000);
    expect(new Date(result.current).getUTCSeconds()).toBe(30);
  });

  it("stops its timer when unmounted", () => {
    const { unmount } = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
