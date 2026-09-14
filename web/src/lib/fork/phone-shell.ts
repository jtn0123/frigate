/**
 * Phone shell classes (fork, flag `phoneFixes`).
 *
 * Upstream reserves the gesture-bar and display-cutout insets only when
 * Frigate runs as an installed PWA. In a Chrome tab that draws edge to edge
 * (`viewport-fit=cover`), the bottom bar can then sit under Android's
 * gesture handle and content under the camera cutout in landscape. Upstream
 * also grows the bar from 3rem to 4rem at the `md` width, which a phone
 * crosses in landscape (about 915 x 412 CSS px), costing video height where
 * there is least of it.
 *
 * These classes always reserve the insets (they resolve to zero wherever
 * the browser does not draw under system UI) and keep phones at 3rem in
 * landscape. Tablets still grow at `md`. `undefined` means flag off: use
 * upstream's classes.
 */

import { isMobileOnly } from "react-device-detect";
import { cn } from "@/lib/utils";
import { phoneFixes } from "@/lib/fork/phone";

const tablet = !isMobileOnly;

type PhoneShellClasses = {
  /** Bottom navigation bar. */
  bar: string;
  /** `#pageRoot`, the area between the top of the screen and the bar. */
  pageRoot: string;
  /** Full-screen `MobilePage` panels, which stop above the bar. */
  mobilePage: string;
};

export const phoneShell: PhoneShellClasses | undefined = phoneFixes
  ? {
      bar: cn(
        "h-[calc(3rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]",
        "landscape:left-[calc(1rem+env(safe-area-inset-left))] landscape:right-[calc(1rem+env(safe-area-inset-right))]",
        tablet && "md:h-[calc(4rem+env(safe-area-inset-bottom))]",
      ),
      pageRoot: cn(
        "bottom-[calc(3rem+env(safe-area-inset-bottom))] left-0 pt-[env(safe-area-inset-top)]",
        "landscape:pl-[env(safe-area-inset-left)] landscape:pr-[env(safe-area-inset-right)]",
        tablet && "md:bottom-[calc(4rem+env(safe-area-inset-bottom))]",
      ),
      mobilePage: cn(
        "mb-[calc(3rem+env(safe-area-inset-bottom))]",
        tablet && "md:mb-[calc(4rem+env(safe-area-inset-bottom))]",
      ),
    }
  : undefined;
