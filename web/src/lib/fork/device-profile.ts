/**
 * Device profile key (fork, flag `liveLayoutMemory`).
 *
 * Per-device preferences such as the live grid arrangement are stored under
 * a key that combines the viewport class ("mobile", "tablet", "desktop")
 * with a random id minted once per browser and kept in localStorage. A
 * phone and a desktop signed in as the same user therefore keep separate
 * layouts, and a window that crosses the tablet/desktop breakpoint switches
 * to the arrangement saved for that size.
 */

import { getViewportClass, type ViewportClass } from "@/hooks/fork/use-viewport";

export const DEVICE_ID_STORAGE_KEY = "frigateDeviceId";

function mintId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

/** Stable per-browser id, created on first use. */
export function getDeviceId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const id = mintId();
    globalThis.localStorage?.setItem(DEVICE_ID_STORAGE_KEY, id);
    return id;
  } catch {
    // Storage blocked (private mode, disabled cookies): fall back to a
    // session-only id so callers still get a usable key.
    return "session";
  }
}

/** `${viewportClass}-${deviceId}`, for example `desktop-3f9a1c0b2d4e`. */
export function getDeviceProfile(cls: ViewportClass = getViewportClass()) {
  return `${cls}-${getDeviceId()}`;
}
