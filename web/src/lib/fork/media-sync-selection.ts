/**
 * Fork: media type selection on Maintenance > Media sync (UI112).
 *
 * Upstream disabled the per-type switches while "All media" was on, so they
 * showed as dimmed-but-checked and read as disabled. Every switch is now
 * live: turning one type off while "All media" is on keeps the others, and
 * picking every type collapses back to "all" (what `/media/sync` expects).
 */

export const ALL_MEDIA = "all";

/** The per-type ids `/media/sync` accepts, in the order the page lists them. */
export const MEDIA_SYNC_TYPES: readonly string[] = [
  "event_snapshots",
  "event_thumbnails",
  "review_thumbnails",
  "previews",
  "exports",
  "recordings",
];

export function toggleMediaType(
  selected: readonly string[],
  id: string,
  checked: boolean,
  allTypes: readonly string[] = MEDIA_SYNC_TYPES,
): string[] {
  if (id === ALL_MEDIA) {
    return checked ? [ALL_MEDIA] : [];
  }
  const current = selected.includes(ALL_MEDIA)
    ? [...allTypes]
    : selected.filter((type) => type !== ALL_MEDIA);
  const next = checked
    ? [...new Set([...current, id])]
    : current.filter((type) => type !== id);
  if (allTypes.length > 0 && allTypes.every((type) => next.includes(type))) {
    return [ALL_MEDIA];
  }
  // keep the order the page lists the types in
  return allTypes.filter((type) => next.includes(type));
}

export function isMediaTypeSelected(
  selected: readonly string[],
  id: string,
): boolean {
  return selected.includes(ALL_MEDIA) || selected.includes(id);
}
