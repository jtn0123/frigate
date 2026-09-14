import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { usePageReady } from "./use-page-ready";
import {
  clearNavigationSamples,
  navigationSnapshot,
} from "@/lib/fork/navigation-metrics";
it("records metadata readiness once and cancels the frame on unmount", () => {
  clearNavigationSamples();
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 42;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const { rerender, unmount } = renderHook(
    ({ ready }) => usePageReady("exports", ready),
    { initialProps: { ready: false } },
  );
  expect(navigationSnapshot()).toHaveLength(0);
  rerender({ ready: true });
  act(() => frame?.(0));
  expect(navigationSnapshot()).toHaveLength(1);
  rerender({ ready: false });
  rerender({ ready: true });
  expect(navigationSnapshot()).toHaveLength(1);
  unmount();
  expect(cancel).toHaveBeenCalledWith(42);
});
