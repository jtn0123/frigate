import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useResizeObserver } from "./resize-observer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("publishes resize dimensions and disconnects on unmount", async () => {
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
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const target = document.createElement("div");
  const ref = { current: target };
  const { result, unmount } = renderHook(() => useResizeObserver(ref));
  expect(observe).toHaveBeenCalledWith(target);
  const rect = { width: 320, height: 180, x: 10, y: 20 } as DOMRectReadOnly;
  await act(() =>
    notify(
      [
        {
          target,
          contentRect: rect,
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    ),
  );
  expect(result.current).toEqual([rect]);
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
