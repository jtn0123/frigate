/**
 * Allow pinch-to-zoom on Android (fork, flag `phoneFixes`).
 *
 * `index.html` ships `maximum-scale=1.0, user-scalable=no`. That stops iOS
 * Safari zooming into focused inputs, but on Android Chrome, which has no
 * such focus zoom, it only blocks people who need to enlarge small text.
 * WCAG 1.4.4 asks that pages can be zoomed. The views that handle their own
 * pinch (the recording timeline, zoomable players) call `preventDefault()`
 * on two-finger touches, so they keep their gesture instead of zooming the
 * page.
 */

import { isAndroid } from "react-device-detect";
import { phoneFixes } from "@/lib/fork/phone";

export const ANDROID_VIEWPORT =
  "width=device-width, initial-scale=1.0, viewport-fit=cover";

export function allowAndroidPageZoom(): void {
  if (!phoneFixes || !isAndroid || typeof document === "undefined") {
    return;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) {
    meta.content = ANDROID_VIEWPORT;
  }
}
