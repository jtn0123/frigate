import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useElementSize } from "./use-element-size";

afterEach(() => {
  vi.unstubAllGlobals();
});

function entry(target: Element, width: number, height: number) {
  return {
    target,
    contentRect: { width, height } as DOMRectReadOnly,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  } satisfies ResizeObserverEntry;
}

it("reports the size of the element the ref attaches to", () => {
  let notify: ResizeObserverCallback = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );

  const { result, unmount } = renderHook(() =>
    useElementSize<HTMLDivElement>(),
  );
  expect(result.current[1]).toEqual({ width: 0, height: 0 });

  const node = document.createElement("div");
  act(() => result.current[0](node));
  expect(observe).toHaveBeenCalledWith(node);

  act(() => notify([entry(node, 640, 360)], {} as ResizeObserver));
  expect(result.current[1]).toEqual({ width: 640, height: 360 });

  // the same size keeps the same object, so nothing re-renders
  const before = result.current[1];
  act(() => notify([entry(node, 640, 360)], {} as ResizeObserver));
  expect(result.current[1]).toBe(before);

  // no entries is ignored
  act(() => notify([], {} as ResizeObserver));
  expect(result.current[1]).toBe(before);

  // detaching the element disconnects its observer
  act(() => result.current[0](null));
  expect(disconnect).toHaveBeenCalledTimes(1);
  unmount();
});
