/**
 * Fullscreen helpers for phones (fork, flag `phoneFixes`).
 *
 * Only the fullscreen element and its descendants are painted while the
 * Fullscreen API is active, so an overlay portalled to `document.body` is
 * invisible. Upstream therefore hides the phone camera-settings drawer in
 * fullscreen; portalling it into the fullscreen element keeps detect,
 * record and audio switches reachable without leaving fullscreen.
 */

/** Element to portal overlays into while `fullscreen` is true. */
export function fullscreenPortalContainer(
  fullscreen: boolean,
): HTMLElement | undefined {
  if (!fullscreen || typeof document === "undefined") {
    return undefined;
  }
  const element = document.fullscreenElement;
  return element instanceof HTMLElement ? element : undefined;
}
