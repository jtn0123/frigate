import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimedHighlights } from "./use-timed-highlights";

describe("useTimedHighlights", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears each name after its own timeout", () => {
    const { result } = renderHook(() => useTimedHighlights(3000));

    act(() => result.current.highlight("door"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => result.current.highlight("gate"));
    expect(result.current.highlighted).toEqual(["door", "gate"]);

    // the second name must not cancel the first one's timeout
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.highlighted).toEqual(["gate"]);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.highlighted).toEqual([]);
  });

  it("restarts a name's timeout when it fires again", () => {
    const { result } = renderHook(() => useTimedHighlights(3000));

    act(() => result.current.highlight("door"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => result.current.highlight("door"));
    expect(result.current.highlighted).toEqual(["door"]);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.highlighted).toEqual(["door"]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.highlighted).toEqual([]);
  });

  it("clears everything at once", () => {
    const { result } = renderHook(() => useTimedHighlights(3000));

    act(() => {
      result.current.highlight("door");
      result.current.highlight("gate");
    });
    act(() => result.current.clear());
    expect(result.current.highlighted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its timeouts on unmount", () => {
    const { result, unmount } = renderHook(() => useTimedHighlights(3000));

    act(() => result.current.highlight("door"));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
