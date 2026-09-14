/**
 * Phone behaviour switches (fork, flag `phoneFixes`).
 *
 * Upstream picks the phone tree from `react-device-detect` at module load;
 * these constants follow the same detection so fork phone fixes apply
 * exactly where upstream already renders its phone layout.
 */

import { isMobile } from "react-device-detect";
import { forkFlags } from "@/fork/flags";

export const phoneFixes: boolean = forkFlags.phoneFixes;

/**
 * Default for `enableHistoryBack` on dialogs, sheets and drawers: on touch
 * devices the system back button (Android's back gesture) closes the
 * top-most overlay instead of leaving the page.
 */
export const overlayBackDefault: boolean = phoneFixes && isMobile;
