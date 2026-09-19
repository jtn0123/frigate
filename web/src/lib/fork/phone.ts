/**
 * Phone behaviour switches (fork, flag `phoneFixes`).
 *
 * Upstream picks the phone tree from `react-device-detect` at module load;
 * these constants follow the same detection so fork phone fixes apply
 * exactly where upstream already renders its phone layout.
 */

import { isMobile, isMobileOnly } from "react-device-detect";
import { forkFlags } from "@/fork/flags";

export const phoneFixes: boolean = forkFlags.phoneFixes;

/**
 * Default for `enableHistoryBack` on dialogs, sheets and drawers: on touch
 * devices the system back button (Android's back gesture) closes the
 * top-most overlay instead of leaving the page.
 */
export const overlayBackDefault: boolean = phoneFixes && isMobile;

/**
 * True on a phone (not a tablet) with the fork's phone fixes on. Gates the
 * 44 px touch targets: upstream's controls are 36 px tall everywhere, which
 * suits a mouse and misses the 44 to 48 px a fingertip needs.
 */
export const phoneTouch: boolean = phoneFixes && isMobileOnly;

/**
 * On a phone the command palette opens from the Settings drawer instead of
 * the bottom bar. The bar is about 380 px wide in portrait: with the palette
 * button it held eight entries at 36 px, without it the rest fit at 48 px.
 * Tablets have the room and keep the button.
 */
export const paletteInSettingsMenu: boolean = phoneTouch;
