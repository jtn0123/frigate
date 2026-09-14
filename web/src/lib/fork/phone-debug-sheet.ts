/**
 * Debug View options as a bottom sheet on phones (fork, flag `phoneFixes`).
 *
 * Upstream stacks the Debug View's options panel under the camera frame on
 * phones, so the options take most of the screen and the frame, the thing
 * being debugged, gets a strip at the top. On phones the panel becomes a
 * bottom sheet instead: hidden below the screen until opened from the
 * Overlays pill, sliding up with a grab handle, and the frame fills the
 * page. The classes restyle upstream's panel in place, so the panel's
 * markup is not moved or re-indented.
 */

import { cn } from "@/lib/utils";

export function phoneDebugSheetClass(open: boolean): string {
  return cn(
    // Sheet surface, pinned to the bottom edge above the gesture bar
    "fixed inset-x-0 bottom-0 z-50 m-0 h-auto max-h-[72dvh] w-full rounded-b-none rounded-t-2xl border-0 border-t border-border bg-background px-4 pt-3",
    "pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-16px_48px_rgba(0,0,0,0.35)]",
    "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
    // Grab handle
    "before:mx-auto before:mb-3 before:block before:h-1.5 before:w-12 before:shrink-0 before:rounded-full before:bg-muted-foreground/30 before:content-['']",
    open ? "translate-y-0" : "pointer-events-none translate-y-[105%]",
  );
}
