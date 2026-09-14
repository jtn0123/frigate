import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhoneDetailControls } from "./use-phone-detail-controls";

describe("usePhoneDetailControls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("steps the controls aside a moment after pausing on a detection", () => {
    const setControls = vi.fn();
    renderHook(() => usePhoneDetailControls(true, false, setControls));

    vi.advanceTimersByTime(1100);
    expect(setControls).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(setControls).toHaveBeenCalledWith(false);
  });

  it("leaves the controls alone while playing", () => {
    const setControls = vi.fn();
    renderHook(() => usePhoneDetailControls(false, false, setControls));

    vi.advanceTimersByTime(5000);
    expect(setControls).not.toHaveBeenCalled();
  });

  it("keeps the controls while the speed menu is open", () => {
    const setControls = vi.fn();
    renderHook(() => usePhoneDetailControls(true, true, setControls));

    vi.advanceTimersByTime(5000);
    expect(setControls).not.toHaveBeenCalled();
  });

  it("does not hide them if playback resumes first", () => {
    const setControls = vi.fn();
    const { rerender } = renderHook(
      ({ paused }) => usePhoneDetailControls(paused, false, setControls),
      { initialProps: { paused: true } },
    );

    vi.advanceTimersByTime(600);
    rerender({ paused: false });
    vi.advanceTimersByTime(5000);
    expect(setControls).not.toHaveBeenCalled();
  });

  it("hides them again on the next pause after a tap brought them back", () => {
    const setControls = vi.fn();
    const { rerender } = renderHook(
      ({ paused }) => usePhoneDetailControls(paused, false, setControls),
      { initialProps: { paused: true } },
    );

    vi.advanceTimersByTime(1300);
    expect(setControls).toHaveBeenCalledTimes(1);
    rerender({ paused: false });
    rerender({ paused: true });
    vi.advanceTimersByTime(1300);
    expect(setControls).toHaveBeenCalledTimes(2);
  });
});
