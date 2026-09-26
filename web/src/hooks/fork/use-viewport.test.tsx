import { act, renderHook } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { getViewportClass, useViewport } from "./use-viewport";

const queries = new Map<string, MediaQueryList>();
let width = 1280;

beforeAll(() => {
  vi.stubGlobal("matchMedia", (media: string) => {
    const query: MediaQueryList = Object.assign(new EventTarget(), {
      media,
      matches: false,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    Object.defineProperty(query, "matches", {
      get: () => width >= (media.includes("768") ? 768 : 1024),
    });
    queries.set(media, query);
    return query;
  });
});

it("updates the shell and device class at each breakpoint", () => {
  const { result, unmount } = renderHook(() => useViewport());
  expect(result.current).toEqual({
    class: "desktop",
    isMobile: false,
    isDesktop: true,
    isTablet: false,
  });
  act(() => {
    width = 820;
    queries.forEach((query) => query.dispatchEvent(new Event("change")));
  });
  expect(result.current.class).toBe("tablet");
  expect(result.current.isDesktop).toBe(true);
  act(() => {
    width = 600;
    queries.forEach((query) => query.dispatchEvent(new Event("change")));
  });
  expect(result.current.isMobile).toBe(true);
  expect(getViewportClass()).toBe("mobile");
  act(() => {
    width = 1280;
    queries.forEach((query) => query.dispatchEvent(new Event("change")));
  });
  expect(result.current.class).toBe("desktop");
  unmount();
});
