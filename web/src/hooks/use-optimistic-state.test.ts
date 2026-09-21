/**
 * Fork: the hook shows the user's click at once and pushes it to the real
 * owner after a delay, so between the two there is a window in which the
 * owner still reports the previous value. What happens to a second click
 * that lands in that window is the whole point of these tests (D49): it used
 * to be discarded when the owner finally echoed the first one back, which
 * left the UI on the value the user had just left and made
 * `review.spec.ts` "switching back to Alerts works" flaky on a busy machine.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useOptimisticState from "./use-optimistic-state";

/** Longer than the delay used below, so every pending push has fired. */
const PAST_THE_DELAY = 200;

type Severity = "alert" | "detection" | "motion";

/**
 * Render the hook the way a component uses it: the owner's value comes in as
 * a prop, so handing a new one back is a rerender.
 */
function renderSeverity(
  initial: Severity,
  setState: (value: Severity) => void,
) {
  return renderHook(
    ({ current }: { current: Severity }) =>
      useOptimisticState<Severity>(current, setState, 100),
    { initialProps: { current: initial } },
  );
}

describe("useOptimisticState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the new value before the owner has it", () => {
    const setState = vi.fn();
    const { result } = renderSeverity("alert", setState);

    act(() => {
      result.current[1]("detection");
    });

    expect(result.current[0]).toBe("detection");
    expect(setState).not.toHaveBeenCalled();
  });

  it("pushes the value to the owner once the delay has passed", () => {
    const setState = vi.fn();
    const { result } = renderSeverity("alert", setState);

    act(() => {
      result.current[1]("detection");
    });
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DELAY);
    });

    expect(setState).toHaveBeenCalledExactlyOnceWith("detection");
  });

  it("adopts a value the owner changed on its own", () => {
    const setState = vi.fn();
    const { result, rerender } = renderSeverity("alert", setState);

    rerender({ current: "motion" });

    expect(result.current[0]).toBe("motion");
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DELAY);
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("keeps a second click made while the first is still in flight", () => {
    const setState = vi.fn();
    const { result, rerender } = renderSeverity("alert", setState);

    act(() => {
      result.current[1]("detection");
    });
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DELAY);
    });
    expect(setState).toHaveBeenCalledExactlyOnceWith("detection");

    // The owner has not come back yet, and the user clicks the tab they
    // started on. This is the window that made the e2e test flaky.
    act(() => {
      result.current[1]("alert");
    });
    expect(result.current[0]).toBe("alert");

    // Now the first click finally arrives back from the owner.
    rerender({ current: "detection" });
    expect(result.current[0]).toBe("alert");

    // And the second click reaches the owner rather than being dropped.
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DELAY);
    });
    expect(setState).toHaveBeenLastCalledWith("alert");

    rerender({ current: "alert" });
    expect(result.current[0]).toBe("alert");
  });

  it("still adopts a different value the owner reports while in flight", () => {
    const setState = vi.fn();
    const { result, rerender } = renderSeverity("alert", setState);

    act(() => {
      result.current[1]("detection");
    });
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DELAY);
    });

    // Not the echo of the click above, so something else moved the owner and
    // it wins, exactly as it did before the echo was tracked.
    rerender({ current: "motion" });

    expect(result.current[0]).toBe("motion");
  });

  it("does not mistake a later external value for the echo it is waiting on", () => {
    const setState = vi.fn();
    const { result, rerender } = renderSeverity("alert", setState);

    act(() => {
      result.current[1]("detection");
    });
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DELAY);
    });
    rerender({ current: "detection" });
    expect(result.current[0]).toBe("detection");

    // The echo has been consumed, so the owner returning to that value later
    // is an external change like any other.
    rerender({ current: "alert" });
    expect(result.current[0]).toBe("alert");
    rerender({ current: "detection" });
    expect(result.current[0]).toBe("detection");
  });
});
