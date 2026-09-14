/**
 * Rotate the screen to fit the video while fullscreen (fork, flag
 * `phoneFixes`).
 *
 * Upstream locks orientation for the single-camera live view only. Recording
 * playback goes fullscreen in whatever way the phone is held, so a 16:9
 * camera plays letterboxed in portrait. This locks to the orientation that
 * fits the camera while fullscreen and unlocks on exit. Browsers without
 * `screen.orientation.lock` (iOS Safari, desktop) are left alone, and a
 * rejected lock (the page is not fullscreen yet) is ignored.
 */

import { useEffect } from "react";

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape" | "portrait") => Promise<void>;
};

export function useFullscreenOrientation(
  active: boolean,
  orientation: "landscape" | "portrait",
): void {
  useEffect(() => {
    // Older WebViews have no ScreenOrientation at all
    const screenOrientation = globalThis.screen.orientation as
      LockableOrientation | undefined;
    if (!active || !screenOrientation?.lock) {
      return;
    }

    screenOrientation.lock(orientation).catch(() => {});
    return () => screenOrientation.unlock();
  }, [active, orientation]);
}
