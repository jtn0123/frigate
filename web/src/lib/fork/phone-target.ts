/**
 * 44 px touch targets for the shared Button on a phone (fork, flag
 * `phoneFixes`).
 *
 * Upstream's `sm` button is 36 px tall and its default 40 px. Almost every
 * control in the app is one of those, so on a phone nearly every tap target
 * missed the 44 px a fingertip needs. A minimum height (and width, for the
 * square icon size) grows them without touching any call site; `xs` stays
 * small because it only sits inside dense desktop rows.
 */

import { phoneTouch } from "@/lib/fork/phone";

type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | null | undefined;

export function phoneTargetClass(size: ButtonSize): string | undefined {
  if (!phoneTouch || size === "xs") {
    return undefined;
  }
  return size === "icon" ? "min-h-11 min-w-11" : "min-h-11";
}

/**
 * For 16 px glyph buttons that sit inline with text (the edit pencils and
 * the "more" dots on the tracked object page): an invisible 44 px hit area
 * around the glyph, so the target grows and the line it sits in does not.
 */
export const phoneHitArea: string | undefined = phoneTouch
  ? "relative after:absolute after:-inset-3.5 after:content-['']"
  : undefined;
