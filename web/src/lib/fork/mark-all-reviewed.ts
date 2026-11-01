/**
 * Fork: mark every finished, unreviewed review item as reviewed (UI155).
 *
 * `GET review` falls back to the last 24 hours when `after` is left out, so
 * the command palette's "Mark all as reviewed" left older items unreviewed.
 * This asks from the start of time and works in pages: marked items drop out
 * of the unreviewed list, so each page reads it again from the top.
 */

import axios from "axios";
import type { ReviewSegment } from "@/types/review";

export const MARK_ALL_PAGE_SIZE = 500;

// The API treats an `after` of 0 as missing and uses the last 24 hours.
const FROM_THE_START = 1;

/**
 * Marks every finished, unreviewed item the user can see and returns how
 * many were marked. Items still in progress are left alone.
 */
export async function markAllUnreviewed(
  pageSize: number = MARK_ALL_PAGE_SIZE,
): Promise<number> {
  const marked = new Set<string>();

  for (;;) {
    const resp = await axios.get<ReviewSegment[]>("review", {
      params: { reviewed: 0, after: FROM_THE_START, limit: pageSize },
    });
    const ids = resp.data
      .filter((seg) => seg.end_time && !marked.has(seg.id))
      .map((seg) => seg.id);

    // nothing new on the page: the rest is in progress or did not change
    if (ids.length === 0) {
      break;
    }

    await axios.post("reviews/viewed", { ids, reviewed: true });
    ids.forEach((id) => marked.add(id));

    if (resp.data.length < pageSize) {
      break;
    }
  }

  return marked.size;
}
