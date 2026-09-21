/**
 * Rail search (fork, UI134).
 *
 * The sidebar used to carry two ways of searching: a magnifier that jumped
 * straight to Explore and a separate command button that opened the palette.
 * They are one entry now. The magnifier opens the palette, which looks through
 * pages, cameras, settings and recorded footage at once, and hands the query
 * on to Explore when the results do not fit.
 */

import { ID_EXPLORE } from "@/hooks/use-navigation";
import { isForkEnabled } from "@/fork/flags";

/** True when the rail entry for `id` is drawn as the search button instead. */
export function isRailSearchItem(id: number): boolean {
  return isForkEnabled("commandPalette") && id === ID_EXPLORE;
}
