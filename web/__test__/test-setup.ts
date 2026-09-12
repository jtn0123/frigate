// Global vitest setup (wired in via `test.setupFiles` in vite.config.ts).
//
// Registers the jest-dom matchers, unmounts anything rendered with
// @testing-library/react after every test, clears localStorage so module
// level state (for example fork feature flags) does not leak between tests,
// and stubs the browser APIs jsdom does not implement.

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Node 22+ declares an experimental `localStorage` global that is undefined
// unless `--localstorage-file` is passed, and vitest's jsdom environment does
// not overwrite globals Node already declares. Provide an in-memory Storage so
// code that reads localStorage at import time behaves like it does in a browser.
if (typeof globalThis.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => store.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      store.delete(String(key));
    },
    clear: () => {
      store.clear();
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    writable: true,
    configurable: true,
    value: memoryStorage,
  });
}

afterEach(() => {
  cleanup();
  globalThis.localStorage?.clear?.();
});

// jsdom has no matchMedia; components that read media queries (theme, mobile
// layout) call it at render time.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
}

// jsdom has no ResizeObserver; layout hooks construct one on mount.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}
