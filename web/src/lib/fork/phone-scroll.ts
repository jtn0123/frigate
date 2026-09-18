/**
 * Scroll hint for one-row strips that scroll sideways on a phone (fork, flag
 * `phoneFixes`): the Explore filter row and the Logs service tabs.
 *
 * Both were cut off mid-word at the right edge with nothing to say there was
 * more. The strip now fades out over its last 2rem, and the content gets the
 * same 2rem of end padding so the last entry can scroll clear of the fade.
 */

import { phoneTouch } from "@/lib/fork/phone";

/** On the element that clips: fades its right edge. */
export const phoneScrollFade: string | undefined = phoneTouch
  ? "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]"
  : undefined;

/** On the scrolling content: room for the last entry past the fade. */
export const phoneScrollEndPad: string | undefined = phoneTouch
  ? "pr-8"
  : undefined;
