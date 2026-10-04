/**
 * Keeping the Spotlights feed fresh while it is open (fork, UI144).
 *
 * The page reads the whole window once. After that it only asks `/review`
 * for what ended since its last read (a few items, not the whole day), when
 * the `reviews` websocket topic says something changed and once a minute in
 * case a message was missed. New items wait behind an "N new items" button
 * so the list does not reshuffle under the pointer; the cards already shown
 * update in place.
 */

import {
  groupMembers,
  type SpotlightGroup,
  type SpotlightItem,
} from "@/lib/fork/spotlights";
import type { ReviewSegment } from "@/types/review";

/** A refresh asks this far back past the last one, for clock skew. */
export const REFRESH_OVERLAP_SECONDS = 120;
/** Lets a burst of review updates settle into one refresh. */
export const REFRESH_DEBOUNCE_MS = 2_000;
/** At most one refresh this often while a review item keeps updating. */
export const REFRESH_MIN_GAP_MS = 15_000;
/** A refresh this often even without a websocket message. */
export const REFRESH_POLL_MS = 60_000;

/** How long to wait before the next refresh, given when the last one ran. */
export function refreshDelay(now: number, lastRun: number | undefined): number {
  if (lastRun === undefined) {
    return REFRESH_DEBOUNCE_MS;
  }
  return Math.max(REFRESH_DEBOUNCE_MS, lastRun + REFRESH_MIN_GAP_MS - now);
}

/** The newest copy of each review item, later reads winning. */
export function addReviews(
  known: ReadonlyMap<string, ReviewSegment>,
  reviews: readonly ReviewSegment[],
): Map<string, ReviewSegment> {
  const next = new Map(known);
  for (const review of reviews) {
    next.set(review.id, review);
  }
  return next;
}

/** The first read with every later copy of an item in place of its own. */
export function mergeReviews(
  base: readonly ReviewSegment[],
  updates: ReadonlyMap<string, ReviewSegment>,
): ReviewSegment[] {
  if (updates.size === 0) {
    return [...base];
  }
  const seen = new Set<string>();
  const merged = base.map((review) => {
    seen.add(review.id);
    return updates.get(review.id) ?? review;
  });
  for (const [id, review] of updates) {
    if (!seen.has(id)) {
      merged.push(review);
    }
  }
  return merged;
}

/** The feed as the page shows it: an order fixed when it was last shown. */
export type PinnedFeed = {
  /** Review ids, best first as of then. */
  ids: readonly string[];
  /** Each item as of then, for one that has since left the window. */
  items: ReadonlyMap<string, SpotlightItem>;
};

export function pinFeed(items: readonly SpotlightItem[]): PinnedFeed {
  return {
    ids: items.map((item) => item.review.id),
    items: new Map(items.map((item) => [item.review.id, item])),
  };
}

export type PinnedView = {
  /** The pinned items in their pinned order, each in its latest state. */
  items: SpotlightItem[];
  /** Items in the latest ranking that are not shown yet. */
  fresh: number;
  /** Their review ids, best first. */
  freshIds: string[];
};

export function readPinned(
  pin: PinnedFeed,
  latest: readonly SpotlightItem[],
): PinnedView {
  const byId = new Map(latest.map((item) => [item.review.id, item]));
  const items: SpotlightItem[] = [];
  for (const id of pin.ids) {
    const item = byId.get(id) ?? pin.items.get(id);
    if (item) {
      items.push(item);
    }
  }
  const pinned = new Set(pin.ids);
  const freshIds = latest
    .filter((item) => !pinned.has(item.review.id))
    .map((item) => item.review.id);
  return { items, fresh: freshIds.length, freshIds };
}

/**
 * The position of the first card holding one of `ids`, or -1. New activity
 * ranks where it ranks, so after "N new items" the page goes there rather
 * than to the top; an item that joined a shown group marks that group.
 */
export function firstArrival(
  groups: readonly SpotlightGroup[],
  ids: ReadonlySet<string>,
): number {
  return groups.findIndex((group) =>
    groupMembers(group).some((member) => ids.has(member.review.id)),
  );
}
