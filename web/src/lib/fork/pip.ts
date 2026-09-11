/**
 * Picture-in-picture support (fork, flag `liveLayoutMemory`).
 *
 * Upstream hides the PiP button by user agent (`!isIOS && !isFirefox`).
 * The players already call the standard `requestPictureInPicture()`, so the
 * button can instead follow the standard feature check
 * `document.pictureInPictureEnabled`, which is absent exactly where the
 * call would fail (Firefox, iOS WebKit) and true everywhere else.
 */

import { isFirefox, isIOS } from "react-device-detect";
import { forkFlags } from "@/fork/flags";

function detect(): boolean {
  if (!forkFlags.liveLayoutMemory) {
    return !isIOS && !isFirefox;
  }
  return (
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled === true &&
    typeof HTMLVideoElement !== "undefined" &&
    typeof HTMLVideoElement.prototype.requestPictureInPicture === "function"
  );
}

/** Whether the standard Picture-in-Picture API is usable in this browser. */
export const pipSupported: boolean = detect();
