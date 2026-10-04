/** Fork (D78): each camera's quiet hours state, worked out from the config. */

import {
  isQuietAt,
  quietHoursOf,
  sameWindows,
  type QuietWindow,
  type WallClock,
} from "@/lib/fork/notification-schedule";
import type { FrigateConfig } from "@/types/frigateConfig";
import { isReplayCamera } from "@/utils/cameraUtil";

import type { QuietState } from "./QuietStatusBadge";

export type CameraRow = {
  name: string;
  /** Saved windows, or undefined when the camera uses the global ones. */
  own: QuietWindow[] | undefined;
  state: QuietState;
};

/**
 * The cameras, whether each uses the global schedule, and whether each is
 * quiet now.
 *
 * Only the saved config counts: unsaved edits to the global windows change
 * nothing until they are saved, so the rows do not follow them.
 *
 * Args:
 *     config: The saved config.
 *     clock: Now, on the schedule's wall clock.
 */
export function cameraRows(
  config: FrigateConfig,
  clock: WallClock,
): CameraRow[] {
  const savedGlobal = quietHoursOf(config.notifications);
  return Object.values(config.cameras)
    .filter(
      (camera) => camera.enabled_in_config && !isReplayCamera(camera.name),
    )
    .sort((a, b) => a.ui.order - b.ui.order)
    .map((camera) => {
      const saved = quietHoursOf(camera.notifications);
      // A camera whose list matches the global one is read as using it,
      // the same reading the settings override badges use.
      const own = sameWindows(saved, savedGlobal) ? undefined : saved;
      // A camera's saved list already holds the global one when it has
      // none of its own, which is the list the server checks
      let state: QuietState = "off";
      if (camera.notifications.enabled) {
        state = isQuietAt(clock, saved) ? "quiet" : "notifying";
      }
      return { name: camera.name, own, state };
    });
}
