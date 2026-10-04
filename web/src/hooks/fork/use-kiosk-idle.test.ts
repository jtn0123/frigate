import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKioskIdle } from "./use-kiosk-idle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useKioskIdle", () => {
  it("goes idle after the timeout and wakes on activity", () => {
    const { result } = renderHook(() => useKioskIdle(3_000));
    expect(result.current.active).toBe(true);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.active).toBe(false);

    act(() => {
      document.dispatchEvent(new Event("pointermove"));
    });
    expect(result.current.active).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2_000);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.active).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.active).toBe(false);
  });

  it("wakes when asked and stops listening after unmount", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { result, unmount } = renderHook(() => useKioskIdle(1_000));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => result.current.wake());
    expect(result.current.active).toBe(true);
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("touchstart", expect.any(Function));
  });
});
