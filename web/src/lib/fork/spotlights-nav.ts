/**
 * The Spotlights rail entry (fork, UI144).
 *
 * Kept apart from the ranking module so the app shell, which builds the rail,
 * does not load the page's code. The phone bar has no free slot, so on a
 * phone the page is reached from the top of the Settings menu
 * (`SpotlightsMenuItem`) and the command palette instead.
 */

import { LuFlashlight } from "react-icons/lu";
import { isForkEnabled } from "@/fork/flags";
import type { NavData } from "@/types/navigation";

export const ID_SPOTLIGHTS = 101;
export const SPOTLIGHTS_PATH = "/spotlights";

export function spotlightsNavItem(
  variant: NonNullable<NavData["variant"]>,
  isDesktop: boolean,
): NavData {
  return {
    id: ID_SPOTLIGHTS,
    variant,
    icon: LuFlashlight,
    // NavItem translates titles in `common`; the prefix points at `fork`
    title: "fork:spotlights.title",
    url: SPOTLIGHTS_PATH,
    enabled: isDesktop && isForkEnabled("spotlights"),
  };
}
