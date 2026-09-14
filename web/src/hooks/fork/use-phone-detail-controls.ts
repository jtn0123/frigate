/**
 * Step the playback controls aside while paused on a detection (fork, flag
 * `phoneFixes`).
 *
 * In Detail mode the player draws the tracked object's box only while
 * paused, and on a phone the always-visible control bar sits across the
 * lower third of the video, right over the person's legs, the bottom of the
 * box and the path. Once playback pauses in Detail mode the controls hide
 * after a moment so the box is readable. A tap on the video brings them back
 * (the player's existing toggle), and they stay until the next pause.
 */

import { useEffect } from "react";

const HIDE_AFTER_MS = 1200;

export function usePhoneDetailControls(
  pausedOnDetection: boolean,
  controlsMenuOpen: boolean,
  setControls: (visible: boolean) => void,
): void {
  useEffect(() => {
    if (!pausedOnDetection || controlsMenuOpen) {
      return;
    }
    const timeout = setTimeout(() => setControls(false), HIDE_AFTER_MS);
    return () => clearTimeout(timeout);
    // Only a new pause (or closing the speed menu) should hide them again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausedOnDetection, controlsMenuOpen]);
}
