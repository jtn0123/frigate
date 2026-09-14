import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFullscreen } from "./use-fullscreen";

const request = vi.fn();
let currentFullscreen: Element | null;

beforeEach(() => {
  currentFullscreen = null;
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => currentFullscreen,
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
  Reflect.deleteProperty(document, "fullscreenElement");
});

function player() {
  const element = document.createElement("div");
  element.requestFullscreen = vi.fn(async () => {
    currentFullscreen = element;
    element.dispatchEvent(new Event("fullscreenchange"));
  });
  const ref = { current: element };
  const hook = renderHook(() => useFullscreen(ref));
  return { element, ...hook };
}

it("enters fullscreen immediately while a wake request is pending, then releases on exit", async () => {
  const lock = { release: vi.fn().mockResolvedValue(undefined) };
  let finish!: (value: typeof lock) => void;
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { element, result } = player();
  await act(() => result.current.toggleFullscreen());
  expect(element.requestFullscreen).toHaveBeenCalledOnce();
  expect(result.current.fullscreen).toBe(true);
  // Escape and native browser controls also produce fullscreenchange.
  act(() => {
    currentFullscreen = null;
    element.dispatchEvent(new Event("fullscreenchange"));
  });
  finish(lock);
  await vi.waitFor(() => expect(lock.release).toHaveBeenCalledOnce());
  expect(result.current.fullscreen).toBe(false);
});

it("releases the wake lock when the fullscreen player unmounts", async () => {
  const lock = { release: vi.fn().mockResolvedValue(undefined) };
  request.mockResolvedValue(lock);
  const { result, unmount } = player();
  await act(() => result.current.toggleFullscreen());
  expect(lock.release).not.toHaveBeenCalled();
  unmount();
  expect(lock.release).toHaveBeenCalledOnce();
});

it("reports a fullscreen failure while releasing its wake lock", async () => {
  const lock = { release: vi.fn().mockResolvedValue(undefined) };
  request.mockResolvedValue(lock);
  const { element, result } = player();
  const failure = new Error("Fullscreen unavailable");
  vi.mocked(element.requestFullscreen).mockRejectedValue(failure);
  await act(() => result.current.toggleFullscreen());
  expect(result.current.error).toBe(failure);
  expect(lock.release).toHaveBeenCalledOnce();
});
