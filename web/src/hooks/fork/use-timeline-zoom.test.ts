import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelineZoom } from "@/hooks/use-timeline-zoom";

const LEVELS = [
  { segmentDuration: 60, timestampSpread: 15 },
  { segmentDuration: 30, timestampSpread: 5 },
  { segmentDuration: 15, timestampSpread: 2 },
];

function timeline() {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientHeight", { value: 100 });
  Object.defineProperty(element, "scrollHeight", { value: 1000 });
  element.scrollTop = 450;
  return element;
}

function setup(element: HTMLDivElement | null = timeline(), level = 1) {
  const onZoomChange = vi.fn();
  const timelineRef = { current: element };
  const zoomSettings = LEVELS.at(level);
  if (!zoomSettings) throw new Error(`no zoom level ${level}`);
  const hook = renderHook(() =>
    useTimelineZoom({
      zoomSettings,
      zoomLevels: LEVELS,
      onZoomChange,
      timelineRef,
      timelineDuration: 3600,
    }),
  );
  // only the no-timeline test passes null, and it never reads the element
  return { ...hook, onZoomChange, element: element as HTMLDivElement };
}

function touches(...points: [number, number][]) {
  return points.map(([clientX, clientY]) => ({ clientX, clientY }));
}

function touchEvent(type: string, points: [number, number][]) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "touches", { value: touches(...points) });
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 1000,
  });
});
afterEach(() => vi.useRealTimers());

describe("useTimelineZoom", () => {
  it("starts at the level matching the settings", () => {
    expect(setup().result.current.zoomLevel).toBe(1);
  });

  it("zooms in, keeps the center time in view and resets the zoom state", () => {
    const { result, onZoomChange, element } = setup();

    act(() => result.current.handleZoom(-1));
    expect(result.current.zoomLevel).toBe(2);
    expect(result.current.isZooming).toBe(true);
    expect(result.current.zoomDirection).toBe("in");
    expect(onZoomChange).toHaveBeenCalledWith(2);

    act(() => {
      vi.advanceTimersByTime(0);
    });
    // center ratio 0.5 of a 3600s timeline at 15s segments of 8px
    expect(element.scrollTop).toBe(0.5 * (3600 / 15) * 8 - 50);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isZooming).toBe(false);
    expect(result.current.zoomDirection).toBeNull();
  });

  it("clamps at the outermost level without notifying", () => {
    const { result, onZoomChange } = setup(timeline(), 0);
    act(() => result.current.handleZoom(1));
    expect(result.current.zoomLevel).toBe(0);
    expect(result.current.zoomDirection).toBe("out");
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("ignores wheel events without ctrl and zooms after enough ctrl delta", () => {
    const { result, element, onZoomChange } = setup();

    const plain = new WheelEvent("wheel", { deltaY: 500, cancelable: true });
    element.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);

    const small = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      cancelable: true,
    });
    element.dispatchEvent(small);
    expect(small.defaultPrevented).toBe(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onZoomChange).not.toHaveBeenCalled();

    act(() => {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 150,
          ctrlKey: true,
          cancelable: true,
        }),
      );
      // ignored while the debounced zoom is pending
      element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -900,
          ctrlKey: true,
          cancelable: true,
        }),
      );
      vi.advanceTimersByTime(200);
    });
    expect(onZoomChange).toHaveBeenCalledWith(0);
    expect(result.current.zoomLevel).toBe(0);
  });

  it("zooms on a pinch past the threshold", () => {
    const { result, element, onZoomChange } = setup();

    const start = touchEvent("touchstart", [
      [0, 0],
      [0, 100],
    ]);
    element.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);

    // 20% of a 1000px window is the threshold
    act(() => {
      element.dispatchEvent(
        touchEvent("touchmove", [
          [0, 0],
          [0, 250],
        ]),
      );
    });
    expect(onZoomChange).not.toHaveBeenCalled();

    act(() => {
      element.dispatchEvent(
        touchEvent("touchmove", [
          [0, 0],
          [0, 400],
        ]),
      );
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(2);
    expect(result.current.zoomLevel).toBe(2);

    act(() => {
      element.dispatchEvent(
        touchEvent("touchmove", [
          [0, 0],
          [0, 100],
        ]),
      );
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(1);
  });

  it("ignores single-finger touches", () => {
    const { element, onZoomChange } = setup();
    const start = touchEvent("touchstart", [[0, 0]]);
    element.dispatchEvent(start);
    element.dispatchEvent(touchEvent("touchmove", [[0, 900]]));
    expect(start.defaultPrevented).toBe(false);
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("removes its listeners on unmount", () => {
    const { element, unmount, onZoomChange } = setup();
    unmount();
    element.dispatchEvent(
      touchEvent("touchstart", [
        [0, 0],
        [0, 10],
      ]),
    );
    element.dispatchEvent(
      touchEvent("touchmove", [
        [0, 0],
        [0, 900],
      ]),
    );
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("does not touch scroll without a timeline element", () => {
    const { result, onZoomChange } = setup(null);
    act(() => result.current.handleZoom(-1));
    expect(result.current.zoomLevel).toBe(2);
    expect(onZoomChange).not.toHaveBeenCalled();
  });
});
