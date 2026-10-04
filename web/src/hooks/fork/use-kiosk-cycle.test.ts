import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKioskCycle } from "./use-kiosk-cycle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Props = { count: number; seconds: number; hold: boolean };

function setup(props: Props) {
  return renderHook(
    (current: Props) =>
      useKioskCycle(current.count, current.seconds, current.hold),
    { initialProps: props },
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useKioskCycle", () => {
  it("advances one slide per interval and wraps", () => {
    const { result } = setup({ count: 3, seconds: 10, hold: false });
    expect(result.current).toMatchObject({ index: 0, running: true });
    advance(9_999);
    expect(result.current.index).toBe(0);
    advance(1);
    expect(result.current.index).toBe(1);
    advance(10_000);
    expect(result.current.index).toBe(2);
    advance(10_000);
    expect(result.current.index).toBe(0);
  });

  it("does not run when off or with one slide", () => {
    const off = setup({ count: 3, seconds: 0, hold: false });
    const alone = setup({ count: 1, seconds: 10, hold: false });
    expect(off.result.current.running).toBe(false);
    expect(alone.result.current.running).toBe(false);
    advance(60_000);
    expect(off.result.current.index).toBe(0);
    expect(alone.result.current.index).toBe(0);
  });

  it("stays put while paused and restarts a full interval on resume", () => {
    const { result } = setup({ count: 3, seconds: 10, hold: false });
    advance(8_000);
    act(() => result.current.togglePaused());
    expect(result.current).toMatchObject({ paused: true, running: false });
    advance(30_000);
    expect(result.current.index).toBe(0);
    act(() => result.current.togglePaused());
    expect(result.current.running).toBe(true);
    advance(9_000);
    expect(result.current.index).toBe(0);
    advance(1_000);
    expect(result.current.index).toBe(1);
  });

  it("steps both ways and gives the new slide a full interval", () => {
    const { result } = setup({ count: 4, seconds: 10, hold: false });
    advance(9_000);
    const epoch = result.current.epoch;
    act(() => result.current.step(-1));
    expect(result.current.index).toBe(3);
    expect(result.current.epoch).toBe(epoch + 1);
    advance(9_000);
    expect(result.current.index).toBe(3);
    advance(1_000);
    expect(result.current.index).toBe(0);
    act(() => result.current.step(1));
    expect(result.current.index).toBe(1);
  });

  it("steps while paused without resuming", () => {
    const { result } = setup({ count: 3, seconds: 10, hold: false });
    act(() => result.current.togglePaused());
    act(() => result.current.step(1));
    expect(result.current).toMatchObject({ index: 1, paused: true });
    advance(30_000);
    expect(result.current.index).toBe(1);
  });

  it("holds during a takeover and restarts the interval after it", () => {
    const { result, rerender } = setup({ count: 3, seconds: 10, hold: false });
    advance(9_000);
    rerender({ count: 3, seconds: 10, hold: true });
    expect(result.current.running).toBe(false);
    advance(20_000);
    expect(result.current.index).toBe(0);
    rerender({ count: 3, seconds: 10, hold: false });
    advance(9_000);
    expect(result.current.index).toBe(0);
    advance(1_000);
    expect(result.current.index).toBe(1);
  });

  it("keeps the index inside a shrinking slide list", () => {
    const { result, rerender } = setup({ count: 3, seconds: 10, hold: false });
    act(() => result.current.step(2));
    expect(result.current.index).toBe(2);
    rerender({ count: 2, seconds: 10, hold: false });
    expect(result.current.index).toBe(0);
    rerender({ count: 0, seconds: 10, hold: false });
    expect(result.current).toMatchObject({ index: 0, running: false });
  });
});
