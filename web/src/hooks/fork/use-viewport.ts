/**
 * Viewport-driven layout class (fork, flag `viewportLayout`).
 *
 * Upstream picks the phone or desktop tree from `react-device-detect`, which
 * sniffs the user agent once at module load. That leaves a narrow desktop
 * window with a sidebar it cannot fit and a phone in landscape with a bottom
 * bar it does not need. These hooks answer the same boolean question from
 * `matchMedia`, so the answer follows the window and is aligned with the
 * Tailwind `md` and `lg` breakpoints the stylesheets already use.
 *
 * Only layout decisions belong here. Capability checks (`isIOS`, `isSafari`,
 * PWA, touch) stay on `react-device-detect`.
 *
 * With the flag off every export returns the `react-device-detect` value so
 * upstream behaviour is unchanged.
 */

import { useSyncExternalStore } from "react";
import {
  isMobile as uaIsMobile,
  isTablet as uaIsTablet,
} from "react-device-detect";
import { forkFlags } from "@/fork/flags";

/** Tailwind `md`. Below this width the app renders the phone shell. */
export const MOBILE_BREAKPOINT = 768;
/** Tailwind `lg`. Between `md` and `lg` is the tablet class. */
export const TABLET_BREAKPOINT = 1024;

export type ViewportClass = "mobile" | "tablet" | "desktop";

export type Viewport = {
  class: ViewportClass;
  /** Narrower than `md`: bottom bar, stacked layouts. */
  isMobile: boolean;
  /** Between `md` and `lg`. Still uses the desktop shell. */
  isTablet: boolean;
  /** `md` and up: sidebar, status bar. Includes the tablet class. */
  isDesktop: boolean;
};

const enabled = forkFlags.viewportLayout;

let mdQuery: MediaQueryList | undefined;
let lgQuery: MediaQueryList | undefined;

function ensureQueries() {
  if (mdQuery || typeof window === "undefined") {
    return;
  }
  if (typeof window.matchMedia !== "function") {
    return;
  }
  mdQuery = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px)`);
  lgQuery = window.matchMedia(`(min-width: ${TABLET_BREAKPOINT}px)`);
}

function subscribe(onChange: () => void) {
  if (!enabled) {
    return () => {};
  }
  ensureQueries();
  mdQuery?.addEventListener("change", onChange);
  lgQuery?.addEventListener("change", onChange);
  return () => {
    mdQuery?.removeEventListener("change", onChange);
    lgQuery?.removeEventListener("change", onChange);
  };
}

function uaViewportClass(): ViewportClass {
  if (uaIsTablet) {
    return "tablet";
  }
  return uaIsMobile ? "mobile" : "desktop";
}

/**
 * Current viewport class. Safe to call outside React (module-level code,
 * event handlers) because it reads the media queries synchronously.
 */
export function getViewportClass(): ViewportClass {
  if (!enabled) {
    return uaViewportClass();
  }
  ensureQueries();
  if (!mdQuery) {
    return uaViewportClass();
  }
  if (!mdQuery.matches) {
    return "mobile";
  }
  if (lgQuery && !lgQuery.matches) {
    return "tablet";
  }
  return "desktop";
}

/** Non-hook equivalent of `useIsMobile()` for module-level callers. */
export function getIsMobile(): boolean {
  return getViewportClass() === "mobile";
}

export function useViewport(): Viewport {
  const cls = useSyncExternalStore(
    subscribe,
    getViewportClass,
    getViewportClass,
  );
  return {
    class: cls,
    isMobile: cls === "mobile",
    isTablet: cls === "tablet",
    isDesktop: cls !== "mobile",
  };
}

/** True below the `md` breakpoint (or `react-device-detect` when off). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getIsMobile, getIsMobile);
}

/** Complement of `useIsMobile()`. */
export function useIsDesktop(): boolean {
  return !useIsMobile();
}
