/**
 * Fullscreen camera controls on phones (fork, flag `phoneFixes`).
 *
 * Upstream's fullscreen controls are the header buttons moved into a
 * corner: a grey gradient back button, toggles in two sizes and colors,
 * and a round settings button, stacked loosely. On a phone they become one
 * rail of 40 px buttons on frosted glass. Inactive controls are translucent
 * white, active ones keep the selected blue so state stays readable over
 * video. The rail is centered on the left edge in landscape (clear of the
 * camera cutout through the safe-area inset) and along the bottom in
 * portrait.
 *
 * The classes reach the existing buttons through descendant selectors, so
 * the upstream buttons are not edited. `undefined` means flag off or not a
 * phone: use upstream's classes.
 */

import { isMobile } from "react-device-detect";
import { phoneFixes } from "@/lib/fork/phone";

const rail = [
  // Frosted container
  "absolute z-40 rounded-2xl bg-black/50 p-1.5 shadow-lg ring-1 ring-white/10 backdrop-blur-md",
  // Portrait: centered along the bottom
  "bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2",
  // Landscape: centered on the left edge
  "landscape:bottom-auto landscape:left-[calc(0.75rem+env(safe-area-inset-left))] landscape:top-1/2 landscape:translate-x-0 landscape:-translate-y-1/2",
  // Every control the same 40 px rounded square
  // (upstream pads the settings toggle and margins icons at `md`, which a
  // landscape phone crosses; both would shrink the icon inside 40 px)
  "[&_[role=button]]:size-10 [&_[role=button]]:rounded-xl [&_[role=button]]:p-0",
  "[&_svg]:m-0 [&_svg]:shrink-0",
  "[&_button[aria-label]]:size-10 [&_button[aria-label]]:rounded-xl [&_button[aria-label]]:p-0",
  // and clear of the 44 px minimum the shared Button has on a phone: over the
  // video, the rail stays as small as it can
  "[&_button[aria-label]]:min-h-0 [&_button[aria-label]]:min-w-0",
  "[&_[role=button]]:min-h-0 [&_[role=button]]:min-w-0",
  // Glass for inactive controls and the back button; active keeps its blue
  "[&_[aria-pressed=false]]:bg-white/15 [&_[aria-pressed=false]]:bg-none",
  "[&_button[aria-label]]:bg-white/15 [&_button[aria-label]]:bg-none",
  "[&_svg]:size-5 [&_[aria-pressed=false]_svg]:text-white [&_button[aria-label]_svg]:text-white",
].join(" ");

export const phoneFullscreenRail: string | undefined =
  phoneFixes && isMobile ? rail : undefined;
